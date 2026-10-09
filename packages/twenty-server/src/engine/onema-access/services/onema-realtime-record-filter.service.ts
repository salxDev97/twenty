import { Injectable, Logger } from '@nestjs/common';

import { ONEMA_ACCESS_LOGGER_CONTEXT } from 'src/engine/onema-access/constants/onema-access.constants';
import { isOnemaAccessPossiblyActive } from 'src/engine/onema-access/utils/resolve-onema-access.util';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';

// rls-design §4, point №3. The realtime publisher broadcasts the record itself —
// the diff of a timeline row, the fields of a lead — so an event about a record
// the subscriber's rules hide is the same leak as a query returning it. The
// publisher has no repository of its own, and this is the one place that builds
// one for a subscriber who is not the actor of the surrounding request.
@Injectable()
export class OnemaRealtimeRecordFilterService {
  private readonly logger = new Logger(ONEMA_ACCESS_LOGGER_CONTEXT);

  constructor(private readonly workspaceOrmManager: WorkspaceOrmManager) {}

  // `undefined` means the rules decide nothing here and the caller keeps its own
  // answer. An empty set means they decided "none", which is also what a failure
  // means: an event that cannot be checked does not go out.
  async resolveVisibleRecordIds({
    objectNameSingular,
    recordIds,
    roleIds,
    workspaceMemberId,
  }: {
    objectNameSingular: string;
    recordIds: string[];
    roleIds: string[];
    workspaceMemberId: string | undefined;
  }): Promise<Set<string> | undefined> {
    // Nothing is configured: not one query, not one repository, and the
    // publisher runs exactly as upstream wrote it
    if (!isOnemaAccessPossiblyActive()) {
      return undefined;
    }

    try {
      const repository = this.workspaceOrmManager.getRepository(
        objectNameSingular,
        { intersectionOf: roleIds },
      );

      return await repository.resolveOnemaVisibleRecordIds({
        recordIds,
        roleIds,
        workspaceMemberId,
      });
    } catch (error) {
      this.logger.error(
        `Onema access rules could not be evaluated for a "${objectNameSingular}" subscription; its events are not delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return new Set();
    }
  }
}
