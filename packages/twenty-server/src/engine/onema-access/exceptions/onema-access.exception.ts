import { msg } from '@lingui/core/macro';

import { CustomException } from 'src/utils/custom-exception';

export const OnemaAccessExceptionCode = {
  INVALID_RULES: 'INVALID_RULES',
  UNKNOWN_OBJECT: 'UNKNOWN_OBJECT',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  RAW_WRITE_REFUSED: 'RAW_WRITE_REFUSED',
} as const;

export type OnemaAccessExceptionCode =
  (typeof OnemaAccessExceptionCode)[keyof typeof OnemaAccessExceptionCode];

export class OnemaAccessException extends CustomException<OnemaAccessExceptionCode> {
  constructor(message: string, code: OnemaAccessExceptionCode) {
    super(message, code, {
      userFriendlyMessage: msg`Record access rules are misconfigured.`,
    });
  }
}
