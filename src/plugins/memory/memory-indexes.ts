import { getPrimaryFieldOfPrimaryKey } from '../../rx-schema-helper';
import type { RxDocumentData, RxJsonSchema } from '../../types';
import type { MemoryStorageInternals } from './memory-types';

export function addIndexesToInternalsState<RxDocType>(
    state: MemoryStorageInternals<RxDocType>,
    schema: RxJsonSchema<RxDocumentData<RxDocType>>
) {
    const primaryPath = getPrimaryFieldOfPrimaryKey(schema.primaryKey) as any;
    const useIndexes: string[][] = !schema.indexes ? [] : schema.indexes.map(row => Array.isArray(row) ? row.slice(0) : [row]) as any;

    // we need this as default index
    useIndexes.push([
        primaryPath
    ]);

    // we need this index for running cleanup()
    useIndexes.push([
        '_meta.lwt',
        primaryPath
    ]);


    useIndexes.forEach(indexAr => {
        /**
         * Running a query will only return non-deleted documents
         * so all indexes must have the the deleted field as first index field.
         */
        indexAr.unshift('_deleted');

        const indexName = getMemoryIndexName(indexAr);
        state.byIndex[indexName] = {
            index: indexAr,
            docsWithIndex: []
        };
    });

    // we need this index for the changes()
    const changesIndex = [
        '_meta.lwt',
        primaryPath
    ];
    const indexName = getMemoryIndexName(changesIndex);
    state.byIndex[indexName] = {
        index: changesIndex,
        docsWithIndex: []
    };

}


export function getMemoryIndexName(index: string[]): string {
    return index.join(',');
}
