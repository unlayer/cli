import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../../components/App.js';
import { KeyValue } from '../../components/KeyValue.js';
import { InteractiveList } from '../../components/InteractiveList.js';
import { createSdkClient } from '../../lib/sdk-client.js';
import { requireAuth } from '../../lib/config.js';
import { renderCommand, jsonError, stdoutWrite, setUsageError } from '../../lib/render.js';
import { isNonInteractive, isJsonMode } from '../../lib/cli-flags.js';
import { formatSelectLabel } from '../../lib/format-option-label.js';
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../../lib/errors.js';

interface TemplateItem {
  id?: string;
  name?: string;
  updatedAt?: string;
}

interface TemplateData {
  id?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  design?: object;
  [key: string]: unknown;
}

type Step = 'loadList' | 'selectTemplate' | 'loadTemplate' | 'display' | 'error';

interface GetTemplateCommandProps {
  templateIdArg?: string;
  json?: boolean;
  output?: string;
  designOnly?: boolean;
  projectId?: string;
}

function GetTemplateCommand({
  templateIdArg,
  json: jsonProp,
  output,
  designOnly,
  projectId,
}: GetTemplateCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const { exit } = useApp();
  const [step, setStep] = useState<Step>(templateIdArg ? 'loadTemplate' : 'loadList');
  const [templatesList, setTemplatesList] = useState<TemplateItem[]>([]);
  const [templateId, setTemplateId] = useState(templateIdArg || '');
  const [template, setTemplate] = useState<TemplateData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load templates list for interactive selection
  useEffect(() => {
    if (step !== 'loadList') return;

    // Non-interactive guard
    if (isNonInteractive()) {
      setUsageError();
      // Still fetch the list to show available IDs in the error
      const client = createSdkClient();
      client.templates
        .list()
        .then((page) => {
          const items = (page.data || []) as TemplateItem[];
          setError(`Non-interactive mode: provide a template-id argument. Available: ${items.map((t) => `${t.id} (${t.name})`).join(', ') || 'none'}`);
          setStep('error');
        })
        .catch(() => {
          setError('Non-interactive mode: provide a template-id argument.');
          setStep('error');
        });
      return;
    }

    const client = createSdkClient();
    client.templates
      .list()
      .then((page) => {
        const items = (page.data || []) as TemplateItem[];
        if (items.length === 0) {
          setError('No templates found.');
          setStep('error');
          return;
        }
        setTemplatesList(items);
        setStep('selectTemplate');
      })
      .catch((err) => {
        setError(errorMessage(err, 'Failed to fetch templates'));
        setStep('error');
      });
  }, [step]);

  // Load single template
  useEffect(() => {
    if (step !== 'loadTemplate' || !templateId) return;
    const client = createSdkClient();
    const retrieveParams: Record<string, unknown> = {};
    if (projectId) retrieveParams.projectId = projectId;
    client.templates
      .retrieve(templateId, retrieveParams)
      .then((response) => {
        setTemplate(response.data as TemplateData);
        setStep('display');
      })
      .catch((err) => {
        setError(errorMessage(err, 'Failed to get template'));
        setStep('error');
      });
  }, [step, templateId]);

  const handleTemplateSelect = useCallback((value: string) => {
    setTemplateId(value);
    setStep('loadTemplate');
  }, []);

  // Handle display/output
  useEffect(() => {
    if (step !== 'display' || !template) return;

    let outputData: unknown;
    if (designOnly) {
      outputData = template.design;
    } else {
      outputData = template;
    }

    if (output === '-') {
      // Write to stdout
      const content =
        typeof outputData === 'string'
          ? outputData
          : JSON.stringify(outputData, null, 2);
      stdoutWrite(content);
      exit();
      return;
    }

    if (output) {
      const outputPath = path.resolve(output);
      const content =
        typeof outputData === 'string'
          ? outputData
          : JSON.stringify(outputData, null, 2);
      try {
        fs.writeFileSync(outputPath, content);
      } catch (err) {
        setError(`Failed to write file: ${err instanceof Error ? err.message : String(err)}`);
        setStep('error');
        return;
      }
    }

    if (json || designOnly) {
      stdoutWrite(JSON.stringify(outputData, null, 2));
      exit();
      return;
    }

    if (output) {
      exit();
      return;
    }

    // Normal display, will auto-exit below
  }, [step, template, json, designOnly, output, exit]);

  useEffect(() => {
    if (step === 'display' && !json && !designOnly && template) {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    if (step === 'error' && error) {
      jsonError(error);
      const timer = setTimeout(() => exit(new Error(error)), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, json, designOnly, template, exit, error]);

  if (step === 'loadList' || (step === 'loadTemplate' && !template)) {
    return (
      <App>
        <Spinner label={step === 'loadList' ? 'Fetching templates...' : 'Fetching template...'} />
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

  if (step === 'selectTemplate' && !isNonInteractive()) {
    const maxNameLen = Math.max(...templatesList.map((t) => (t.name || 'Untitled').length), 10);
    const items = templatesList.map((t) => ({
      label: formatSelectLabel([
        { text: t.name || 'Untitled', width: Math.min(maxNameLen, 40) },
        { text: `ID: ${t.id}`, width: 14 },
        {
          text: t.updatedAt
            ? new Date(t.updatedAt).toLocaleDateString()
            : '\u2014',
          width: 12,
        },
      ]),
      value: String(t.id),
    }));

    return (
      <App>
        <InteractiveList
          title="Select a template"
          items={items}
          onSelect={handleTemplateSelect}
          onCancel={() => exit()}
        />
      </App>
    );
  }

  if (step === 'display' && template && !json && !designOnly) {
    return (
      <App>
        <Box flexDirection="column" gap={1}>
          <Text bold>{` Template: ${template.name}`}</Text>
          <KeyValue
            pairs={[
              { key: 'ID', value: template.id },
              { key: 'Name', value: template.name },
              {
                key: 'Created',
                value: template.createdAt
                  ? new Date(template.createdAt).toLocaleDateString()
                  : null,
              },
              {
                key: 'Updated',
                value: template.updatedAt
                  ? new Date(template.updatedAt).toLocaleDateString()
                  : null,
              },
            ]}
          />
          {output && (
            <StatusMessage variant="success">
              {`Template saved to: ${path.resolve(output)}`}
            </StatusMessage>
          )}
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={2}
          >
            <Text bold>Options</Text>
            <Text dimColor>
              Use <Text color="cyan">--json</Text> to get full template data
            </Text>
            <Text dimColor>
              Use <Text color="cyan">--design-only</Text> to get just the design JSON
            </Text>
            <Text dimColor>
              Use <Text color="cyan">-o {'<file>'}</Text> to save to a file
            </Text>
          </Box>
          <Text color="green">  Template info loaded</Text>
        </Box>
      </App>
    );
  }

  return <></>;
}

export const getTemplateCommand = new Command('get')
  .description('Get a template by ID')
  .argument('[template-id]', 'Template ID (interactive selection if not provided)')
  .option('--json', 'Output as JSON')
  .option('-o, --output <file>', 'Save output to file (use - for stdout)')
  .option('--design-only', 'Output only the design JSON')
  .option('--project-id <id>', 'Project ID to scope the template lookup')
  .action((templateIdArg, options) => {
    requireAuth();
    const { waitUntilExit } = renderCommand(
      <GetTemplateCommand
        templateIdArg={templateIdArg}
        json={options.json}
        output={options.output}
        designOnly={options.designOnly}
        projectId={options.projectId}
      />,
    );
    waitUntilExit().catch((err) => {
      if (err) process.exit(process.exitCode || 1);
    });
  });
