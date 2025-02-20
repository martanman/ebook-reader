/**
 * @license BSD-3-Clause
 * Copyright (c) 2023, ッツ Reader Authors
 * All rights reserved.
 */

import type {
  BooksDbBookData,
  BooksDbBookmarkData
} from '$lib/data/database/books-db/versions/books-db';
import { database, fsStorageSource$ } from '$lib/data/store';

import { BaseStorageHandler } from '$lib/data/storage/handler/base-handler';
import type { BookCardProps } from '$lib/components/book-card/book-card-props';
import { ReplicationSaveBehavior } from '$lib/functions/replication/replication-options';
import { StorageKey } from '$lib/data/storage/storage-types';
import StorageUnlock from '$lib/components/storage-unlock.svelte';
import type { StorageUnlockAction } from '$lib/data/storage/storage-source-manager';
import { dialogManager } from '$lib/data/dialog-manager';
import { getStorageHandler } from '$lib/data/storage/storage-handler-factory';
import { handleErrorDuringReplication } from '$lib/functions/replication/error-handler';
import pLimit from 'p-limit';
import { replicationProgress$ } from '$lib/functions/replication/replication-progress';
import { throwIfAborted } from '$lib/functions/replication/replication-error';

export class FilesystemStorageHandler extends BaseStorageHandler {
  private rootDirectory: FileSystemDirectoryHandle | undefined;

  private titleToDirectory = new Map<string, FileSystemDirectoryHandle>();

  private titleToFiles = new Map<string, FileSystemFileHandle[]>();

  updateSettings(
    window: Window,
    isForBrowser: boolean,
    saveBehavior: ReplicationSaveBehavior,
    cacheStorageData: boolean,
    askForStorageUnlock: boolean,
    storageSourceName: string
  ) {
    this.window = window;
    this.isForBrowser = isForBrowser;
    this.saveBehavior = saveBehavior;
    this.cacheStorageData = cacheStorageData;
    this.askForStorageUnlock = askForStorageUnlock;

    const newStorageSource = storageSourceName || fsStorageSource$.getValue();

    if (newStorageSource !== this.storageSourceName) {
      this.clearData();
    }

    this.storageSourceName = newStorageSource;
  }

  async getBookList() {
    if (!this.dataListFetched) {
      database.listLoading$.next(true);

      const rootDirectory = await this.ensureRoot();
      const directories = (await FilesystemStorageHandler.list(
        rootDirectory,
        true
      )) as FileSystemDirectoryHandle[];

      await this.setTitleData(directories);

      this.dataListFetched = true;
    }

    return [...this.titleToBookCard.values()];
  }

  clearData(clearAll = true) {
    this.titleToFiles.clear();

    if (clearAll) {
      this.rootDirectory = undefined;
      this.titleToDirectory.clear();
      this.titleToBookCard.clear();
      this.dataListFetched = false;
    }
  }

  async prepareBookForReading(): Promise<number> {
    const book = await database.getDataByTitle(this.currentContext.title);

    let idToReturn = 0;
    let data: Omit<BooksDbBookData, 'id'> | undefined = book;

    if (!data || !data.elementHtml) {
      const { file } = await this.getExternalFile('bookdata_');

      data = file
        ? data || {
            title: this.currentContext.title,
            styleSheet: '',
            elementHtml: '',
            blobs: {},
            coverImage: '',
            hasThumb: true,
            characters: 0,
            sections: [],
            lastBookModified: 0,
            lastBookOpen: 0,
            storageSource: undefined
          }
        : undefined;
    }

    if (!data) {
      throw new Error('No local or external book data found');
    }

    if (data.storageSource !== this.storageSourceName) {
      data.storageSource = this.storageSourceName;

      idToReturn = await getStorageHandler(
        this.window,
        StorageKey.BROWSER,
        undefined,
        true,
        this.cacheStorageData,
        ReplicationSaveBehavior.Overwrite
      ).saveBook(data, true, false);
    } else if (book?.id) {
      idToReturn = book.id;
    }

    return idToReturn;
  }

  async updateLastRead(book: BooksDbBookData) {
    const { file, files, rootDirectory } = await this.getExternalFile('bookdata_');

    if (!file) {
      return;
    }

    const bookData = await file.getFile();
    const filename = BaseStorageHandler.getBookFileName(book);
    const { characters, lastBookModified, lastBookOpen } =
      BaseStorageHandler.getBookMetadata(filename);

    await this.writeFile(rootDirectory, filename, bookData, files, file);

    this.addBookCard(this.currentContext.title, { characters, lastBookModified, lastBookOpen });
  }

  async getFilenameForRecentCheck(fileIdentifier: string) {
    if (this.saveBehavior === ReplicationSaveBehavior.Overwrite) {
      BaseStorageHandler.reportProgress();
      return undefined;
    }

    const { file } = await this.getExternalFile(fileIdentifier, 1);

    return file?.name;
  }

  async isBookPresentAndUpToDate(referenceFilename: string | undefined) {
    if (!referenceFilename) {
      BaseStorageHandler.reportProgress();
      return false;
    }

    const { file } = await this.getExternalFile('bookdata_', 1);

    let isPresentAndUpToDate = false;

    if (file && this.saveBehavior === ReplicationSaveBehavior.NewOnly) {
      const { lastBookModified, lastBookOpen } =
        BaseStorageHandler.getBookMetadata(referenceFilename);
      const { lastBookModified: existingBookModified, lastBookOpen: existingBookOpen } =
        BaseStorageHandler.getBookMetadata(file.name);

      isPresentAndUpToDate = !!(
        existingBookModified &&
        lastBookModified &&
        existingBookModified >= lastBookModified &&
        (existingBookOpen || 0) >= (lastBookOpen || 0)
      );
    }

    return isPresentAndUpToDate;
  }

  async isProgressPresentAndUpToDate(referenceFilename: string | undefined) {
    if (!referenceFilename) {
      BaseStorageHandler.reportProgress();
      return false;
    }

    const { file } = await this.getExternalFile('progress_', 1);

    let isPresentAndUpToDate = false;

    if (file && this.saveBehavior === ReplicationSaveBehavior.NewOnly) {
      const { lastBookmarkModified } = BaseStorageHandler.getProgressMetadata(referenceFilename);
      const { lastBookmarkModified: existingBookmarkModified } =
        BaseStorageHandler.getProgressMetadata(file.name);

      isPresentAndUpToDate = !!(
        existingBookmarkModified &&
        lastBookmarkModified &&
        (existingBookmarkModified || 0) >= (lastBookmarkModified || 0)
      );
    }

    return isPresentAndUpToDate;
  }

  async getBook() {
    const { file } = await this.getExternalFile('bookdata_', this.isForBrowser ? 0.4 : 0.8);

    if (!file) {
      return undefined;
    }

    const bookFile = await file.getFile();

    return this.isForBrowser ? this.extractBookData(bookFile, bookFile.name, 0.6) : bookFile;
  }

  async getProgress() {
    const { file } = await this.getExternalFile('progress_', this.isForBrowser ? 0.6 : 0.8);

    if (!file) {
      return undefined;
    }

    const progressFile = await file.getFile();

    if (this.isForBrowser) {
      const progress = JSON.parse(await FilesystemStorageHandler.readFileObject(progressFile));

      BaseStorageHandler.reportProgress(0.4);
      return progress;
    }

    return progressFile;
  }

  async getCover() {
    if (this.currentContext.imagePath instanceof Blob) {
      BaseStorageHandler.reportProgress();

      return this.currentContext.imagePath;
    }

    const { file } = await this.getExternalFile('cover_', 0.8);

    if (!file) {
      return undefined;
    }

    const cover = await file.getFile();

    return cover;
  }

  async saveBook(data: Omit<BooksDbBookData, 'id'> | File, skipTimestampFallback = true) {
    const isFile = data instanceof File;
    const { file, files, rootDirectory } = await this.getExternalFile('bookdata_', 0.2);
    const filename = BaseStorageHandler.getBookFileName(
      data,
      file && skipTimestampFallback ? '' : file?.name
    );
    const { characters, lastBookModified, lastBookOpen } =
      BaseStorageHandler.getBookMetadata(filename);

    if (file && this.saveBehavior === ReplicationSaveBehavior.NewOnly) {
      const { lastBookModified: existingBookModified, lastBookOpen: existingBookOpen } =
        BaseStorageHandler.getBookMetadata(file.name);

      if (
        existingBookModified &&
        lastBookModified &&
        existingBookModified >= lastBookModified &&
        (existingBookOpen || 0) >= (lastBookOpen || 0)
      ) {
        return 0;
      }
    }

    let bookData;

    if (isFile) {
      bookData = data;
      BaseStorageHandler.reportProgress(0.2);
    } else {
      bookData = await this.zipBookData(data, 0.4);
    }

    await this.writeFile(rootDirectory, filename, bookData, files, file, isFile ? 0.6 : 0.4);

    this.addBookCard(this.currentContext.title, { characters, lastBookModified, lastBookOpen });

    return 0;
  }

  async saveProgress(data: BooksDbBookmarkData | File) {
    const filename = BaseStorageHandler.getProgressFileName(data);
    const { lastBookmarkModified, progress } = BaseStorageHandler.getProgressMetadata(filename);
    const { file, files, rootDirectory } = await this.getExternalFile('progress_');

    if (file && this.saveBehavior === ReplicationSaveBehavior.NewOnly) {
      const { lastBookmarkModified: existingBookmarkModified } =
        BaseStorageHandler.getProgressMetadata(file.name);

      if (
        existingBookmarkModified &&
        lastBookmarkModified &&
        (existingBookmarkModified || 0) >= (lastBookmarkModified || 0)
      ) {
        return;
      }
    }

    await this.writeFile(
      rootDirectory,
      filename,
      data instanceof File ? data : JSON.stringify(data),
      files,
      file,
      0.6
    );

    this.addBookCard(this.currentContext.title, { lastBookmarkModified, progress });
  }

  async saveCover(data: Blob | undefined) {
    if (!data) {
      BaseStorageHandler.reportProgress();
      return;
    }

    const { file, files, rootDirectory } = await this.getExternalFile('cover_');

    if (!file) {
      const filename = await BaseStorageHandler.getCoverFileName(data);

      await this.writeFile(rootDirectory, filename, data, files, undefined, 0.6);
    }

    if (this.titleToBookCard.has(this.currentContext.title)) {
      this.addBookCard(this.currentContext.title, { imagePath: data });
    }
  }

  async deleteBookData(booksToDelete: string[], cancelSignal: AbortSignal) {
    const rootDirectory = await this.ensureRoot();
    const deleted: number[] = [];
    const deletionLimiter = pLimit(1);
    const deleteTasks: Promise<void>[] = [];

    let error = '';

    replicationProgress$.next({ progressBase: 1, maxProgress: booksToDelete.length });

    booksToDelete.forEach((bookToDelete) =>
      deleteTasks.push(
        deletionLimiter(async () => {
          try {
            throwIfAborted(cancelSignal);

            await rootDirectory.removeEntry(BaseStorageHandler.sanitizeForFilename(bookToDelete), {
              recursive: true
            });

            const deletedId = this.titleToBookCard.get(bookToDelete)?.id;

            if (deletedId) {
              deleted.push(deletedId);
            }

            this.titleToDirectory.delete(bookToDelete);
            this.titleToFiles.delete(bookToDelete);
            this.titleToBookCard.delete(bookToDelete);

            database.dataListChanged$.next(this);

            BaseStorageHandler.reportProgress();
          } catch (err) {
            error = handleErrorDuringReplication(err, `Error deleting ${bookToDelete}: `, [
              deletionLimiter
            ]);
          }
        })
      )
    );

    await Promise.all(deleteTasks).catch(() => {});

    return { error, deleted };
  }

  private async ensureRoot(
    askForStorageUnlock = this.askForStorageUnlock
  ): Promise<FileSystemDirectoryHandle> {
    try {
      if (this.rootDirectory) {
        await FilesystemStorageHandler.verifyPermission(this.rootDirectory);

        return this.rootDirectory;
      }

      const db = await database.db;
      const storageSource = await db.get('storageSource', this.storageSourceName);

      if (!storageSource) {
        throw new Error(`No storage source with name ${this.storageSourceName} found`);
      }

      const handleData = storageSource.data;

      if (handleData instanceof ArrayBuffer) {
        throw new Error('Wrong filesystem handle type');
      }

      if (!handleData.directoryHandle) {
        throw new Error('Filesystem handle not found');
      }

      await FilesystemStorageHandler.verifyPermission(handleData.directoryHandle);

      this.rootDirectory = handleData.directoryHandle;
    } catch (error: any) {
      if (
        error.message.includes('activation is required') &&
        (!this.rootDirectory || askForStorageUnlock)
      ) {
        await new Promise<StorageUnlockAction | undefined>((resolver) => {
          dialogManager.dialogs$.next([
            {
              component: StorageUnlock,
              props: {
                description: 'You are trying to access data on your filesystem',
                action: 'Please grant permissions in the next dialog',
                requiresSecret: false,
                resolver
              },
              disableCloseOnClick: true
            }
          ]);
        });

        return this.ensureRoot(false);
      }

      throw error;
    }

    return this.rootDirectory;
  }

  private async setTitleData(directories: FileSystemDirectoryHandle[], clearDataOnError = true) {
    const listLimiter = pLimit(1);
    const listTasks: Promise<void>[] = [];

    directories.forEach((directory) =>
      listTasks.push(
        listLimiter(async () => {
          try {
            const files = (await FilesystemStorageHandler.list(
              directory
            )) as FileSystemFileHandle[];

            if (!files.length) {
              return;
            }

            const bookCard: BookCardProps = {
              id: BaseStorageHandler.getDummyId(),
              title: BaseStorageHandler.desanitizeFilename(directory.name),
              imagePath: '',
              characters: 0,
              lastBookModified: 0,
              lastBookOpen: 0,
              progress: 0,
              lastBookmarkModified: 0,
              isPlaceholder: false
            };
            const fileLimiter = pLimit(1);
            const fileTasks: Promise<void>[] = [];

            files.forEach((file) =>
              fileTasks.push(
                fileLimiter(async () => {
                  try {
                    if (file.name.startsWith('bookdata_')) {
                      const metadata = BaseStorageHandler.getBookMetadata(file.name);

                      bookCard.characters = metadata.characters;
                      bookCard.lastBookModified = metadata.lastBookModified;
                      bookCard.lastBookOpen = metadata.lastBookOpen;
                    } else if (file.name.startsWith('progress_')) {
                      const metadata = BaseStorageHandler.getProgressMetadata(file.name);

                      bookCard.lastBookmarkModified = metadata.lastBookmarkModified;
                      bookCard.progress = metadata.progress;
                    } else if (file.name.startsWith('cover_')) {
                      bookCard.imagePath = await file.getFile();
                    }
                  } catch (error) {
                    fileLimiter.clearQueue();
                    throw error;
                  }
                })
              )
            );

            await Promise.all(fileTasks);

            this.titleToDirectory.set(bookCard.title, directory);
            this.titleToFiles.set(bookCard.title, files);
            this.titleToBookCard.set(bookCard.title, bookCard);
          } catch (error) {
            listLimiter.clearQueue();
            throw error;
          }
        })
      )
    );

    await Promise.all(listTasks).catch((error) => {
      if (clearDataOnError) {
        this.clearData();
      }

      throw error;
    });
  }

  private async getExternalFile(fileIdentifier: string, progressBase = 0.4) {
    const progressPerStep = progressBase / 2;
    const rootDirectory = await this.ensureRoot();

    BaseStorageHandler.reportProgress(progressPerStep);

    const files = await this.getExternalFiles(rootDirectory);
    const file = files.find((entry) => entry.name.startsWith(fileIdentifier));

    BaseStorageHandler.reportProgress(progressPerStep);

    return { file, files, rootDirectory };
  }

  private async getExternalFiles(
    rootHandle: FileSystemDirectoryHandle
  ): Promise<FileSystemFileHandle[]> {
    if (
      (!this.cacheStorageData || !this.dataListFetched) &&
      !this.titleToFiles.has(this.currentContext.title)
    ) {
      const directory = await rootHandle
        .getDirectoryHandle(this.sanitizedTitle, { create: false })
        .catch(() => {
          // no-op
        });

      if (directory) {
        await this.setTitleData([directory], false);
      }
    }

    return this.titleToFiles.get(this.currentContext.title) || [];
  }

  private async writeFile(
    rootDirectory: FileSystemDirectoryHandle,
    filename: string,
    data: any,
    files: FileSystemFileHandle[],
    file: FileSystemFileHandle | undefined,
    progressBase = 0.4
  ) {
    const progressPerStep = progressBase / 2;
    const directory =
      this.titleToDirectory.get(this.currentContext.title) ||
      (await rootDirectory.getDirectoryHandle(this.sanitizedTitle, { create: true }));
    const savedFile = await directory.getFileHandle(filename, { create: true });
    const writer = await savedFile.createWritable();

    await writer.write(data);
    await writer.close();

    BaseStorageHandler.reportProgress(progressPerStep);

    if (file) {
      if (!(await savedFile.isSameEntry(file))) {
        await directory.removeEntry(file.name);
      }

      const titleFiles = files.filter((entry) => entry.name !== file.name);

      titleFiles.push(savedFile);

      this.titleToFiles.set(this.currentContext.title, titleFiles);
    } else {
      files.push(savedFile);

      this.titleToFiles.set(this.currentContext.title, files);
    }

    this.titleToDirectory.set(this.currentContext.title, directory);

    BaseStorageHandler.reportProgress(progressPerStep);
  }

  private static async verifyPermission(handle: FileSystemDirectoryHandle) {
    const options: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };

    if ((await handle.queryPermission(options)) === 'granted') {
      return true;
    }

    if ((await handle.requestPermission(options)) === 'granted') {
      return true;
    }

    throw new Error('No permissions granted to access filesystem');
  }

  private static async list(directory: FileSystemDirectoryHandle, listDirectories = false) {
    const entries: (FileSystemDirectoryHandle | FileSystemFileHandle)[] = [];
    const listIterator = directory.values();

    let entry = await listIterator.next();

    while (!entry.done) {
      if (entry.value.kind === 'directory' && listDirectories) {
        entries.push(entry.value);
      } else if (entry.value.kind === 'file') {
        entries.push(entry.value);
      }

      // eslint-disable-next-line no-await-in-loop
      entry = await listIterator.next();
    }

    return entries;
  }

  private static readFileObject(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.addEventListener('load', () => {
        resolve(reader.result as string);
      });

      reader.addEventListener('error', () => {
        reject(new Error(`Error reading file ${file.name}`));
      });

      reader.readAsText(file);
    });
  }
}
