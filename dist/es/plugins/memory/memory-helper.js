import { getIndexableString } from '../../custom-index';
import { pushAtSortPosition } from 'array-push-at-sort-position';
import { newRxError } from '../../rx-error';
import { boundEQ } from './binary-search-bounds';
export function getMemoryCollectionKey(databaseName, collectionName) {
  return databaseName + '--memory--' + collectionName;
}
export function ensureNotRemoved(instance) {
  if (instance.internals.removed) {
    throw new Error('removed');
  }
}
export function putWriteRowToState(primaryPath, schema, state, row, docInState) {
  var docId = row.document[primaryPath];
  state.documents.set(docId, row.document);
  Object.values(state.byIndex).forEach(function (byIndex) {
    var docsWithIndex = byIndex.docsWithIndex;
    var newIndexString = getIndexableString(schema, byIndex.index, row.document);

    var _pushAtSortPosition = pushAtSortPosition(docsWithIndex, {
      id: docId,
      doc: row.document,
      indexString: newIndexString
    }, function (a, b) {
      if (a.indexString < b.indexString) {
        return -1;
      } else {
        return 1;
      }
    }, true),
        insertPosition = _pushAtSortPosition[1];
    /**
     * Remove previous if it was in the state
     */


    if (docInState) {
      var previousIndexString = getIndexableString(schema, byIndex.index, docInState);

      if (previousIndexString === newIndexString) {
        /**
         * Index not changed -> The old doc must be before or after the new one.
         */
        var prev = docsWithIndex[insertPosition - 1];

        if (prev && prev.id === docId) {
          docsWithIndex.splice(insertPosition - 1, 1);
        } else {
          var next = docsWithIndex[insertPosition + 1];

          if (next.id === docId) {
            docsWithIndex.splice(insertPosition + 1, 1);
          } else {
            throw newRxError('SNH', {
              args: {
                row: row,
                byIndex: byIndex
              }
            });
          }
        }
      } else {
        /**
         * Index changed, we must search for the old one and remove it.
         */
        var indexBefore = boundEQ(docsWithIndex, {
          indexString: previousIndexString
        }, compareDocsWithIndex);
        docsWithIndex.splice(indexBefore, 1);
      }
    }
  });
}
export function removeDocFromState(primaryPath, schema, state, doc) {
  var docId = doc[primaryPath];
  state.documents["delete"](docId);
  Object.values(state.byIndex).forEach(function (byIndex) {
    var docsWithIndex = byIndex.docsWithIndex;
    var indexString = getIndexableString(schema, byIndex.index, doc);
    var positionInIndex = boundEQ(docsWithIndex, {
      indexString: indexString
    }, compareDocsWithIndex);
    docsWithIndex.splice(positionInIndex, 1);
  });
}
export function compareDocsWithIndex(a, b) {
  if (a.indexString < b.indexString) {
    return -1;
  } else if (a.indexString === b.indexString) {
    return 0;
  } else {
    return 1;
  }
}
//# sourceMappingURL=memory-helper.js.map