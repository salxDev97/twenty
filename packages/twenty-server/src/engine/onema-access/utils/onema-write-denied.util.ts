import {
  PermissionsException,
  PermissionsExceptionCode,
} from 'src/engine/metadata-modules/permissions/permissions.exception';

// A refused write is a permission error, not an empty result: unlike a read,
// where denial has to look like "no such record", the caller asked to change
// something and must learn that it did not happen. Upstream's own permission
// exception is reused so every API surface — GraphQL, REST, the workers —
// already knows how to turn it into a 403 without a line of core code.
export const onemaWriteDenied = (message: string): PermissionsException =>
  new PermissionsException(
    `Onema access rules refuse this write: ${message}`,
    PermissionsExceptionCode.PERMISSION_DENIED,
  );
