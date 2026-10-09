import {
  PermissionsException,
  PermissionsExceptionCode,
} from 'src/engine/metadata-modules/permissions/permissions.exception';

// A refused write is a permission error, not an empty result: unlike a read,
// where denial has to look like "no such record", the caller asked to change
// something and must learn that it did not happen. Upstream's own permission
// exception is reused so every API surface — GraphQL, REST, the workers — turns
// it into a 403 the way it already does.
//
// Under its own code rather than PERMISSION_DENIED, which is what the review
// asked for: an invariant of the product and a denial of a caller's rights are
// different answers, and a `catch` that treats a denial as "no such record" —
// resolveWritableRecordIds does exactly that — would otherwise quietly drop the
// rows an invariant refused instead of letting the refusal through.
export const onemaWriteDenied = (message: string): PermissionsException =>
  new PermissionsException(
    `Onema access rules refuse this write: ${message}`,
    PermissionsExceptionCode.ONEMA_WRITE_DENIED,
  );
