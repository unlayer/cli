import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../components/App.js';
import { createSdkClient } from '../lib/sdk-client.js';
import { requireAuth, getDefaultOutputDir } from '../lib/config.js';
import { renderCommand, jsonError, stdoutWrite } from '../lib/render.js';
import { isJsonMode } from '../lib/cli-flags.js';
import { sanitizeName } from '../lib/format-option-label.js';
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../lib/errors.js';

interface TemplateListItem {
  id?: string;
  name?: string;
}

interface TemplateData {
  id?: string;
  name?: string;
  displayMode?: string;
  design?: object;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface PulledFile {
  id: string;
  name: string;
  path: string;
}

type Step = 'collecting' | 'pulling' | 'done' | 'error';

interface PullCommandProps {
  id?: string;
  outputDir?: string;
  projectId?: string;
  designOnly?: boolean;
  json?: boolean;
}

function PullCommand({
  id: singleId,
  outputDir: outputDirFlag,
  projectId,
  designOnly,
  json: jsonProp,
}: PullCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const { exit } = useApp();
  const [step, setStep] = useState<Step>(singleId ? 'pulling' : 'collecting');
  const [templateIds, setTemplateIds] = useState<TemplateListItem[]>([]);
  const [pulled, setPulled] = useState<PulledFile[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  const outputDir = outputDirFlag || getDefaultOutputDir();

  // Step 1: Collect all template IDs (if no --id given)
  useEffect(() => {
    if (step !== 'collecting') return;

    const client = createSdkClient(undefined, undefined, projectId ? Number(projectId) : undefined);

    (async () => {
      try {
        const allTemplates: TemplateListItem[] = [];
        for await (const t of client.templates.list()) {
          allTemplates.push(t as TemplateListItem);
        }

        if (allTemplates.length === 0) {
          setError('No templates found.');
          setStep('error');
          return;
        }

        setTemplateIds(allTemplates);
        setProgress({ current: 0, total: allTemplates.length });
        setStep('pulling');
      } catch (err) {
        setError(errorMessage(err, 'Failed to list templates'));
        setStep('error');
      }
    })();
  }, [step, projectId]);

  // Step 2: Pull templates (retrieve full data + save)
  useEffect(() => {
    if (step !== 'pulling') return;

    const client = createSdkClient(undefined, undefined, projectId ? Number(projectId) : undefined);
    const resolvedDir = path.resolve(outputDir);

    (async () => {
      try {
        // Create output directory
        fs.mkdirSync(resolvedDir, { recursive: true });

        const ids = singleId
          ? [{ id: singleId, name: undefined as string | undefined }]
          : templateIds;

        const total = ids.length;
        setProgress({ current: 0, total });

        const results: PulledFile[] = [];

        for (let i = 0; i < ids.length; i++) {
          const item = ids[i];
          const tid = String(item.id);

          const retrieveParams: Record<string, unknown> = {};
          if (projectId) retrieveParams.projectId = projectId;

          const response = await client.templates.retrieve(tid, retrieveParams);
          const tmpl = response.data as TemplateData;

          const name = tmpl.name || item.name || 'untitled';
          const safeName = sanitizeName(name);
          const filename = `${safeName}-${tid}.json`;
          const filePath = path.join(resolvedDir, filename);

          // Save file
          let content: string;
          if (designOnly) {
            content = JSON.stringify(tmpl.design, null, 2);
          } else {
            // Full envelope format
            const envelope = {
              id: tmpl.id,
              name: tmpl.name,
              displayMode: tmpl.displayMode,
              design: tmpl.design,
              createdAt: tmpl.createdAt,
              updatedAt: tmpl.updatedAt,
            };
            content = JSON.stringify(envelope, null, 2);
          }

          fs.writeFileSync(filePath, content);

          results.push({
            id: tid,
            name: tmpl.name || name,
            path: path.relative(process.cwd(), filePath) || filePath,
          });

          setProgress({ current: i + 1, total });
        }

        setPulled(results);
        setStep('done');
      } catch (err) {
        setError(errorMessage(err, 'Failed to pull templates'));
        setStep('error');
      }
    })();
  }, [step, singleId, templateIds, outputDir, projectId, designOnly]);

  // Handle done/error exit
  useEffect(() => {
    if (step === 'done') {
      if (json) {
        stdoutWrite(JSON.stringify(pulled, null, 2));
      }
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    if (step === 'error' && error) {
      jsonError(error);
      const timer = setTimeout(() => exit(new Error(error)), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, pulled, json, exit, error]);

  if (step === 'collecting') {
    return (
      <App>
        <Spinner label="Discovering templates..." />
      </App>
    );
  }

  if (step === 'pulling') {
    const label = progress.total > 0
      ? `Pulling templates... ${progress.current}/${progress.total}`
      : 'Pulling template...';
    return (
      <App>
        <Spinner label={label} />
      </App>
    );
  }

  if (step === 'error' && error) {
    return (
      <App>
        <StatusMessage variant="error">{error}</StatusMessage>
      </App>
    );
  }

  if (step === 'done' && !json) {
    return (
      <App>
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="success">
            {`Pulled ${pulled.length} template(s) to ${path.resolve(outputDir)}`}
          </StatusMessage>
          {pulled.map((p) => (
            <Text key={p.id} dimColor>{`  ${p.path}`}</Text>
          ))}
        </Box>
      </App>
    );
  }

  return <></>;
}

export const pullCommand = new Command('pull')
  .description('Pull templates from Unlayer to local files')
  .option('--id <id>', 'Pull a single template by ID')
  .option('--output-dir <dir>', 'Output directory (default: ./templates)')
  .option('--project-id <id>', 'Project ID to scope the template lookup')
  .option('--design-only', 'Save only the design JSON (not the full envelope)')
  .option('--json', 'Output as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ unlayer pull                                    # All templates -> ./templates/
  $ unlayer pull --id 42                            # Single template
  $ unlayer pull --output-dir ./my-templates        # Custom dir
  $ unlayer pull --project-id 3 --design-only       # Design JSON only
  $ unlayer pull --json 2>/dev/null                 # Machine-readable output
`,
  )
  .action((options) => {
    requireAuth();
    const { waitUntilExit } = renderCommand(
      <PullCommand
        id={options.id}
        outputDir={options.outputDir}
        projectId={options.projectId}
        designOnly={options.designOnly}
        json={options.json}
      />,
    );
    waitUntilExit().catch((err) => {
      if (err) process.exit(process.exitCode || 1);
    });
  });
