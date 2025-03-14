import type { BulkWriteRow, RxDocumentData, RxJsonSchema } from '../../types';
import type { DocWithIndexString, MemoryStorageInternals } from './memory-types';
import type { RxStorageInstanceMemory } from './rx-storage-instance-memory';
export declare function getMemoryCollectionKey(databaseName: string, collectionName: string): string;
export declare function ensureNotRemoved(instance: RxStorageInstanceMemory<any>): void;
export declare function putWriteRowToState<RxDocType>(primaryPath: string, schema: RxJsonSchema<RxDocumentData<RxDocType>>, state: MemoryStorageInternals<RxDocType>, row: BulkWriteRow<RxDocType>, docInState?: RxDocumentData<RxDocType>): void;
export declare function removeDocFromState<RxDocType>(primaryPath: string, schema: RxJsonSchema<RxDocumentData<RxDocType>>, state: MemoryStorageInternals<RxDocType>, doc: RxDocumentData<RxDocType>): void;
export declare function compareDocsWithIndex<RxDocType>(a: DocWithIndexString<RxDocType>, b: DocWithIndexString<RxDocType>): 1 | 0 | -1;
