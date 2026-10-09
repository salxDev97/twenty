import { type JestConfigWithTsJest } from 'ts-jest';

import jestIntegrationConfig from './jest-integration.config';

// Onema fork (ADR-003), rls-design §12а Т-2. The freeze race: concurrent
// mutations against one row, where what the scheduler does with them is part of
// the test. It is a probabilistic check — with the row lock removed it came back
// red in two runs out of three — so it is kept out of the mandatory run
// (jest-integration.config.ts ignores this directory) and runs on its own:
//   npx nx run twenty-server:test:integration:onema-race
//
// The deterministic half of the same question is in the mandatory run: that the
// pre-image of the freeze is read under `SELECT … FOR UPDATE` in the transaction
// about to write it (onema-write-access.integration-spec.ts).
const jestConfig: JestConfigWithTsJest = {
  ...jestIntegrationConfig,
  testRegex: 'test/integration/onema-race/.*\\.integration-spec\\.ts$',
  testPathIgnorePatterns: [],
};

export default jestConfig;
