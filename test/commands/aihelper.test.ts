/*
 * Copyright (c) 2025, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { Config } from '@oclif/core';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { PackageAiHelperCommand } from '../../src/commands/aihelper.js';

describe('aihelper - tests', () => {
  const $$ = new TestContext();
  const config = new Config({ root: import.meta.url });

  beforeEach(async () => {
    await config.load();
    stubSfCommandUx($$.SANDBOX);

    // Mock fetch for AI service calls
    $$.SANDBOX.stub(global, 'fetch').resolves({
      ok: true,
      json: () =>
        Promise.resolve({
          generationDetails: {
            generations: [
              {
                content: 'This is a test AI response',
                role: 'assistant',
              },
            ],
          },
        }),
    } as Response);
  });

  afterEach(() => {
    $$.restore();
  });

  it('should require token flag', async () => {
    const cmd = new PackageAiHelperCommand([], config);

    try {
      await cmd.run();
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect((error as Error).message).to.include('Missing required flag token');
    }
  });

  it('should create command instance with token', () => {
    const cmd = new PackageAiHelperCommand(['--token', 'test-token'], config);

    expect(cmd).to.be.instanceOf(PackageAiHelperCommand);
    expect(cmd.id).to.equal('aihelper');
  });

  it('should create command instance with all flags', () => {
    const cmd = new PackageAiHelperCommand(
      ['--token', 'test-token', '--location', 'https://custom-endpoint.com', '--verbose'],
      config
    );

    expect(cmd).to.be.instanceOf(PackageAiHelperCommand);
    expect(cmd.id).to.equal('aihelper');
  });

  it('should have correct static properties', () => {
    expect(PackageAiHelperCommand.summary).to.include('AI helper');
    expect(PackageAiHelperCommand.description).to.include('interactive AI assistant');
    expect(PackageAiHelperCommand.examples).to.be.an('array');
    expect(PackageAiHelperCommand.flags).to.have.property('token');
    expect(PackageAiHelperCommand.flags).to.have.property('location');
    expect(PackageAiHelperCommand.flags).to.have.property('verbose');
  });

  it('should validate required token flag configuration', () => {
    const tokenFlag = PackageAiHelperCommand.flags.token;
    expect(tokenFlag.required).to.be.true;
    expect(tokenFlag.char).to.equal('t');
  });

  it('should validate optional flags configuration', () => {
    const locationFlag = PackageAiHelperCommand.flags.location;
    expect(locationFlag.required).to.be.false;
    expect(locationFlag.char).to.equal('l');

    const verboseFlag = PackageAiHelperCommand.flags.verbose;
    expect(verboseFlag.default).to.be.false;
    expect(verboseFlag.char).to.equal('v');
  });
});
