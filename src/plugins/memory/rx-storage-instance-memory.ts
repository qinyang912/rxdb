import { Observable, Subject } from 'rxjs';
import { getStartIndexStringFromLowerBound, getStartIndexStringFromUpperBound, MAX_CHAR } from '../../custom-index';
import { newRxError } from '../../rx-error';
import { getPrimaryFieldOfPrimaryKey } from '../../rx-schema-helper';
import { categorizeBulkWriteRows } from '../../rx-storage-helper';
import type {
    BulkWriteRow,
    EventBulk,
    MangoQuery,
    RxDocumentData,
    RxJsonSchema,
    RxStorageBulkWriteResponse,
    RxStorageChangeEvent,
    RxStorageInstance,
    RxStorageInstanceCreationParams,
    RxStorageQueryResult
} from '../../types';
import { ensureNotFalsy, now, RX_META_LWT_MINIMUM } from '../../util';
import { getDexieKeyRange } from '../dexie/query/dexie-query';
import { RxStorageDexieStatics } from '../dexie/rx-storage-dexie';
import { pouchSwapIdToPrimaryString } from '../pouchdb';
import { boundGE, boundGT } from './binary-search-bounds';
import {
    compareDocsWithIndex,
    ensureNotRemoved,
    getMemoryCollectionKey,
    putWriteRowToState,
    removeDocFromState
} from './memory-helper';
import { addIndexesToInternalsState, getMemoryIndexName } from './memory-indexes';
import type {
    MemoryChangesCheckpoint,
    MemoryPreparedQuery,
    MemoryStorageInternals,
    RxStorageMemory,
    RxStorageMemoryInstanceCreationOptions,
    RxStorageMemorySettings
} from './memory-types';

const IDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

export class RxStorageInstanceMemory<RxDocType> implements RxStorageInstance<
    RxDocType,
    MemoryStorageInternals<RxDocType>,
    RxStorageMemoryInstanceCreationOptions
> {

    public readonly primaryPath: keyof RxDocType;
    private changes$: Subject<EventBulk<RxStorageChangeEvent<RxDocumentData<RxDocType>>>> = new Subject();
    public closed = false;

    constructor(
        public readonly storage: RxStorageMemory,
        public readonly databaseName: string,
        public readonly collectionName: string,
        public readonly schema: Readonly<RxJsonSchema<RxDocumentData<RxDocType>>>,
        public readonly internals: MemoryStorageInternals<RxDocType>,
        public readonly options: Readonly<RxStorageMemoryInstanceCreationOptions>,
        public readonly settings: RxStorageMemorySettings
    ) {
        this.primaryPath = getPrimaryFieldOfPrimaryKey(this.schema.primaryKey) as any;
    }

    bulkWrite(documentWrites: BulkWriteRow<RxDocType>[]): Promise<RxStorageBulkWriteResponse<RxDocType>> {
        ensureNotRemoved(this);

        const ret: RxStorageBulkWriteResponse<RxDocType> = {
            success: {},
            error: {}
        };

        const docsInDb: Map<RxDocumentData<RxDocType>[keyof RxDocType], RxDocumentData<RxDocType>> = new Map();
        documentWrites.forEach(writeRow => {
            const docId = writeRow.document[this.primaryPath];
            const docInDb = this.internals.documents.get(docId as any);
            if (docInDb) {
                docsInDb.set(docId, docInDb);
            }
        });


        const categorized = categorizeBulkWriteRows<RxDocType>(
            this,
            this.primaryPath,
            docsInDb,
            documentWrites
        );
        categorized.errors.forEach(err => {
            ret.error[err.documentId] = err;
        });

        /**
         * Do inserts/updates
         */
        categorized.bulkInsertDocs.forEach(writeRow => {
            const docId = writeRow.document[this.primaryPath];
            putWriteRowToState(
                this.primaryPath as any,
                this.schema,
                this.internals,
                writeRow,
                undefined
            );
            ret.success[docId as any] = writeRow.document;
        });

        categorized.bulkUpdateDocs.forEach(writeRow => {
            const docId = writeRow.document[this.primaryPath];
            putWriteRowToState(
                this.primaryPath as any,
                this.schema,
                this.internals,
                writeRow,
                docsInDb.get(docId)
            );
            ret.success[docId as any] = writeRow.document;
        });

        this.changes$.next(categorized.eventBulk);

        return Promise.resolve(ret);
    }

    async findDocumentsById(
        docIds: string[],
        withDeleted: boolean
    ): Promise<{ [documentId: string]: RxDocumentData<RxDocType>; }> {
        const ret: { [documentId: string]: RxDocumentData<RxDocType>; } = {};
        docIds.forEach(docId => {
            const docInDb = this.internals.documents.get(docId);
            if (
                docInDb &&
                (
                    !docInDb._deleted ||
                    withDeleted
                )
            ) {
                ret[docId] = docInDb;
            }
        });
        return Promise.resolve(ret);
    }

    async query(preparedQuery: MemoryPreparedQuery<RxDocType>): Promise<RxStorageQueryResult<RxDocType>> {
        const skip = preparedQuery.skip ? preparedQuery.skip : 0;
        const limit = preparedQuery.limit ? preparedQuery.limit : Infinity;
        const skipPlusLimit = skip + limit;
        const queryPlan = (preparedQuery as any).pouchQueryPlan;

        const queryMatcher = RxStorageDexieStatics.getQueryMatcher(
            this.schema,
            preparedQuery
        );
        const sortComparator = RxStorageDexieStatics.getSortComparator(this.schema, preparedQuery);


        const keyRange = getDexieKeyRange(
            queryPlan,
            Number.NEGATIVE_INFINITY,
            MAX_CHAR,
            IDBKeyRange
        );

        const queryPlanFields: string[] = queryPlan.index.def.fields
            .map((fieldObj: any) => Object.keys(fieldObj)[0])
            .map((field: any) => pouchSwapIdToPrimaryString(this.primaryPath, field));

        const sortFields = ensureNotFalsy((preparedQuery as MangoQuery<RxDocType>).sort)
            .map(sortPart => Object.keys(sortPart)[0]);

        /**
         * If the cursor iterated over the same index that
         * would be used for sorting, we do not have to sort the results.
         */
        const sortFieldsSameAsIndexFields = queryPlanFields.join(',') === sortFields.join(',');
        /**
         * Also manually sort if one part of the sort is in descending order
         * because all our indexes are ascending.
         * TODO should we be able to define descending indexes?
         */
        const isOneSortDescending = preparedQuery.sort.find((sortPart: any) => Object.values(sortPart)[0] === 'desc');
        const mustManuallyResort = isOneSortDescending || !sortFieldsSameAsIndexFields;


        const index: string[] | undefined = ['_deleted'].concat(queryPlanFields);
        let lowerBound = Array.isArray(keyRange.lower) ? keyRange.lower : [keyRange.lower];
        lowerBound = [false].concat(lowerBound);

        const lowerBoundString = getStartIndexStringFromLowerBound(
            this.schema,
            index,
            lowerBound
        );

        let upperBound = Array.isArray(keyRange.upper) ? keyRange.upper : [keyRange.upper];
        upperBound = [false].concat(upperBound);
        const upperBoundString = getStartIndexStringFromUpperBound(
            this.schema,
            index,
            upperBound
        );
        const indexName = getMemoryIndexName(index);
        const docsWithIndex = this.internals.byIndex[indexName].docsWithIndex;
        let indexOfLower = boundGE(
            docsWithIndex,
            {
                indexString: lowerBoundString
            } as any,
            compareDocsWithIndex
        );

        let rows: RxDocumentData<RxDocType>[] = [];
        let done = false;
        while (!done) {
            const currentDoc = docsWithIndex[indexOfLower];

            if (
                !currentDoc ||
                currentDoc.indexString > upperBoundString
            ) {
                break;
            }

            if (queryMatcher(currentDoc.doc)) {
                rows.push(currentDoc.doc);
            }

            if (
                (rows.length >= skipPlusLimit && !isOneSortDescending) ||
                indexOfLower >= docsWithIndex.length
            ) {
                done = true;
            }

            indexOfLower++;
        }

        if (mustManuallyResort) {
            rows = rows.sort(sortComparator);
        }

        // apply skip and limit boundaries.
        rows = rows.slice(skip, skipPlusLimit);


        return {
            documents: rows
        };
    }

    async getChangedDocumentsSince(
        limit: number,
        checkpoint?: MemoryChangesCheckpoint
    ): Promise<{
        document: RxDocumentData<RxDocType>;
        checkpoint: MemoryChangesCheckpoint;
    }[]> {
        const sinceLwt = checkpoint ? checkpoint.lwt : RX_META_LWT_MINIMUM;
        const sinceId = checkpoint ? checkpoint.id : '';

        const index = ['_meta.lwt', this.primaryPath as any];
        const indexName = getMemoryIndexName(index);

        const lowerBoundString = getStartIndexStringFromLowerBound(
            this.schema,
            ['_meta.lwt', this.primaryPath as any],
            [
                sinceLwt,
                sinceId
            ]
        );

        const docsWithIndex = this.internals.byIndex[indexName].docsWithIndex;



        let indexOfLower = boundGT(
            docsWithIndex,
            {
                indexString: lowerBoundString
            } as any,
            compareDocsWithIndex
        );

        // TODO use array.slice() so we do not have to iterate here
        const rows: RxDocumentData<RxDocType>[] = [];
        while (rows.length < limit && indexOfLower < docsWithIndex.length) {
            const currentDoc = docsWithIndex[indexOfLower];
            rows.push(currentDoc.doc);
            indexOfLower++;
        }

        return rows.map(docData => ({
            document: docData,
            checkpoint: {
                id: docData[this.primaryPath] as any,
                lwt: docData._meta.lwt
            }
        }));
    }

    async cleanup(minimumDeletedTime: number): Promise<boolean> {
        const maxDeletionTime = now() - minimumDeletedTime;
        const index = ['_deleted', '_meta.lwt', this.primaryPath as any];
        const indexName = getMemoryIndexName(index);
        const docsWithIndex = this.internals.byIndex[indexName].docsWithIndex;

        const lowerBoundString = getStartIndexStringFromLowerBound(
            this.schema,
            index,
            [
                true,
                0,
                ''
            ]
        );

        let indexOfLower = boundGT(
            docsWithIndex,
            {
                indexString: lowerBoundString
            } as any,
            compareDocsWithIndex
        );

        let done = false;
        while (!done) {
            const currentDoc = docsWithIndex[indexOfLower];
            if (!currentDoc || currentDoc.doc._meta.lwt > maxDeletionTime) {
                done = true;
            } else {
                removeDocFromState(
                    this.primaryPath as any,
                    this.schema,
                    this.internals,
                    currentDoc.doc
                );
                indexOfLower++;
            }
        }

        return true;
    }


    getAttachmentData(_documentId: string, _attachmentId: string): Promise<string> {
        ensureNotRemoved(this);
        throw new Error('Attachments are not implemented in the memory RxStorage. Make a pull request.');
    }

    changeStream(): Observable<EventBulk<RxStorageChangeEvent<RxDocumentData<RxDocType>>>> {
        ensureNotRemoved(this);
        return this.changes$.asObservable();
    }

    async remove(): Promise<void> {
        ensureNotRemoved(this);

        this.internals.removed = true;
        this.storage.collectionStates.delete(
            getMemoryCollectionKey(this.databaseName, this.collectionName)
        );
        await this.close();
    }

    async close(): Promise<void> {
        if (this.closed) {
            throw newRxError('SNH', {
                database: this.databaseName,
                collection: this.collectionName
            });
        }
        this.closed = true;
        this.changes$.complete();

        this.internals.refCount = this.internals.refCount - 1;
        if (this.internals.refCount === 0) {
            this.storage.collectionStates.delete(
                getMemoryCollectionKey(this.databaseName, this.collectionName)
            );
        }
    }
}



export async function createMemoryStorageInstance<RxDocType>(
    storage: RxStorageMemory,
    params: RxStorageInstanceCreationParams<RxDocType, RxStorageMemoryInstanceCreationOptions>,
    settings: RxStorageMemorySettings
): Promise<RxStorageInstanceMemory<RxDocType>> {

    const collectionKey = getMemoryCollectionKey(params.databaseName, params.collectionName);


    let internals = storage.collectionStates.get(collectionKey);
    if (!internals) {
        internals = {
            removed: false,
            refCount: 1,
            documents: new Map(),
            byIndex: {}
        };
        addIndexesToInternalsState(internals, params.schema);
        storage.collectionStates.set(collectionKey, internals);
    } else {
        internals.refCount = internals.refCount + 1;
    }

    const instance = new RxStorageInstanceMemory(
        storage,
        params.databaseName,
        params.collectionName,
        params.schema,
        internals,
        params.options,
        settings
    );
    return instance;
}
