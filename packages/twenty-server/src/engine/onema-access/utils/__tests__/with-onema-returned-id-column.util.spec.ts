import { setOnemaAccessRulesForTesting } from 'src/engine/onema-access/utils/load-onema-access-rules.util';
import { withOnemaReturnedIdColumn } from 'src/engine/onema-access/utils/with-onema-returned-id-column.util';

const anyRules = {
  roles: { member: '00000000-0000-4000-8000-000000000001' },
  objects: { company: { member: { all: true } as const } },
};

describe('withOnemaReturnedIdColumn', () => {
  afterEach(() => setOnemaAccessRulesForTesting(undefined));

  it('returns the list untouched while no rules file is configured', () => {
    setOnemaAccessRulesForTesting(undefined);

    expect(withOnemaReturnedIdColumn(['name'])).toEqual(['name']);
  });

  it('adds the id the check after the write reads', () => {
    setOnemaAccessRulesForTesting(anyRules);

    expect(withOnemaReturnedIdColumn(['name'])).toEqual(['name', 'id']);
  });

  it('leaves a list that already names the id alone', () => {
    setOnemaAccessRulesForTesting(anyRules);

    const columnsToReturn = ['id', 'name'];

    expect(withOnemaReturnedIdColumn(columnsToReturn)).toBe(columnsToReturn);
  });
});
