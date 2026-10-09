import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { destroyOneOperationFactory } from 'test/integration/graphql/utils/destroy-one-operation-factory.util';
import { makeGraphqlApiRequest as makeRequestAsAdmin } from 'test/integration/graphql/utils/make-graphql-api-request.util';

export type OnemaFixtureCompany = {
  id: string;
  name: string;
  accountOwnerId: string;
};

export type OnemaFixturePerson = {
  id: string;
  jobTitle: string;
  companyId: string;
};

// Several upstream suites empty `company` and `person` of the test workspace
// (test/integration/utils/delete-all-records.ts), so the dev seed is gone for
// whatever runs after them in a full integration run: every row the Onema
// suites read is created here and destroyed when the suite ends
export const createFixtureCompany = async ({
  name,
  accountOwnerId,
}: {
  name: string;
  accountOwnerId: string;
}): Promise<OnemaFixtureCompany> => {
  const response = await makeRequestAsAdmin(
    createOneOperationFactory({
      objectMetadataSingularName: 'company',
      gqlFields: 'id name accountOwner { id }',
      data: { name, accountOwnerId },
    }),
  );

  expect(response.body.errors).toBeUndefined();

  return {
    id: response.body.data.createCompany.id,
    name,
    accountOwnerId,
  };
};

export const createFixturePerson = async ({
  jobTitle,
  companyId,
}: {
  jobTitle: string;
  companyId: string;
}): Promise<OnemaFixturePerson> => {
  const response = await makeRequestAsAdmin(
    createOneOperationFactory({
      objectMetadataSingularName: 'person',
      gqlFields: 'id jobTitle company { id }',
      data: { jobTitle, companyId },
    }),
  );

  expect(response.body.errors).toBeUndefined();

  return {
    id: response.body.data.createPerson.id,
    jobTitle,
    companyId,
  };
};

export const destroyFixtureRecords = async ({
  objectMetadataSingularName,
  recordIds,
}: {
  objectMetadataSingularName: string;
  recordIds: string[];
}): Promise<void> => {
  for (const recordId of recordIds) {
    await makeRequestAsAdmin(
      destroyOneOperationFactory({
        objectMetadataSingularName,
        gqlFields: 'id',
        recordId,
      }),
    );
  }
};
