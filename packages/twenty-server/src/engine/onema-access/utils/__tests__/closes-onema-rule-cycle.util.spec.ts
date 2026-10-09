import { closesOnemaRuleCycle } from 'src/engine/onema-access/utils/closes-onema-rule-cycle.util';

describe('closesOnemaRuleCycle', () => {
  it('lets a chain reach an object it has not visited', () => {
    expect(
      closesOnemaRuleCycle({
        objectPath: ['projectMember', 'project'],
        objectName: 'task',
        cycleExemptObjectName: 'projectMember',
      }),
    ).toBe(false);
  });

  // The one return the seed causes: `project`'s rule reads other rows of the
  // object being written, under their own rule, and stops there
  it('lets the chain return to the written object once', () => {
    expect(
      closesOnemaRuleCycle({
        objectPath: ['projectMember', 'project'],
        objectName: 'projectMember',
        cycleExemptObjectName: 'projectMember',
      }),
    ).toBe(false);
  });

  // The growth the review named: the exemption used to stand for the whole walk,
  // so the only thing between a rule and an unbounded nest of subqueries over
  // the same table was ONEMA_MAX_RULE_DEPTH
  it('closes the chain on a second return to the written object', () => {
    expect(
      closesOnemaRuleCycle({
        objectPath: ['projectMember', 'project', 'projectMember', 'task'],
        objectName: 'projectMember',
        cycleExemptObjectName: 'projectMember',
      }),
    ).toBe(true);
  });

  it('closes the chain on any other object coming round twice', () => {
    expect(
      closesOnemaRuleCycle({
        objectPath: ['projectMember', 'project'],
        objectName: 'project',
        cycleExemptObjectName: 'projectMember',
      }),
    ).toBe(true);
  });

  // A read seeds no exemption, so a rule walking back to its own object is the
  // cycle it always was
  it('closes the chain on a revisit when nothing is exempt', () => {
    expect(
      closesOnemaRuleCycle({
        objectPath: ['projectMember', 'project'],
        objectName: 'projectMember',
      }),
    ).toBe(true);
  });
});
