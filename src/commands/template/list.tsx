import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../../components/App.js';
import { DataTable } from '../../components/DataTable.js';
import { InteractiveList } from '../../components/InteractiveList.js';
import { TemplateActions } from '../../components/TemplateActions.js';
import { createSdkClient } from '../../lib/sdk-client.js';
import { requireAuth } from '../../lib/config.js';
import { renderCommand, jsonError, stdoutWrite } from '../../lib/render.js';
import { isJsonMode, isNonInteractive } from '../../lib/cli-flags.js';
import { formatSelectLabel } from '../../lib/format-option-label.js';
import { errorMessage } from '../../lib/errors.js';

interface TemplateItem {
  id?: string;
  name?: string;
  updatedAt?: string;
}

type Step = 'loading' | 'selectTemplate' | 'templateAction' | 'done' | 'cancelled' | 'error';

interface ListTemplatesCommandProps {
  json?: boolean;
  projectId?: string;
  limit?: number;
  search?: string;
}

function ListTemplatesCommand({ json: jsonProp, projectId, limit, search }: ListTemplatesCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const nonInteractive = json || isNonInteractive();
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('loading');
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [selectedTemplateName, setSelectedTemplateName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Load templates
  useEffect(() => {
    if (step !== 'loading') return;

    const client = createSdkClient();
    const listParams: Record<string, unknown> = {};
    if (projectId) listParams.projectId = projectId;
    if (search) listParams.name = search;

    (async () => {
      try {
        const allTemplates: TemplateItem[] = [];
        for await (const t of client.templates.list(listParams)) {
          allTemplates.push(t as TemplateItem);
          if (limit && allTemplates.length >= limit) break;
        }
        setTemplates(allTemplates);

        if (nonInteractive) {
          setStep('done');
        } else if (allTemplates.length === 0) {
          setStep('done');
        } else {
          setStep('selectTemplate');
        }
      } catch (err) {
        setError(errorMessage(err, 'Failed to list templates'));
        setStep('error');
      }
    })();
  }, [step, projectId, limit, search, nonInteractive]);

  // Handle done/exit for non-interactive and JSON
  useEffect(() => {
    if (step === 'done' && nonInteractive) {
      if (json && !error) {
        stdoutWrite(JSON.stringify(templates, null, 2));
      }
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    if (step === 'done' && templates.length === 0) {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    if (step === 'cancelled') {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
    if (step === 'error' && error) {
      jsonError(error);
      const timer = setTimeout(() => exit(new Error(error)), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, json, nonInteractive, templates, exit, error]);

  // Exit after TemplateActions completes
  const handleActionDone = useCallback(() => {
    const timer = setTimeout(() => exit(), 100);
    return () => clearTimeout(timer);
  }, [exit]);

  const handleActionCancel = useCallback(() => {
    setSelectedTemplateId(null);
    setSelectedTemplateName('');
    setStep('selectTemplate');
  }, []);

  const handleTemplateSelect = useCallback((value: string) => {
    const tmpl = templates.find((t) => String(t.id) === value);
    setSelectedTemplateId(value);
    setSelectedTemplateName(tmpl?.name || 'Untitled');
    setStep('templateAction');
  }, [templates]);

  const handleCancel = useCallback(() => {
    setStep('cancelled');
  }, []);

  // ── Render ──────────────────────────────────────────────

  if (step === 'loading') {
    return (
      <App>
        <Spinner label="Fetching templates..." />
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

  // Non-interactive: static DataTable (unchanged behavior)
  if (step === 'done' && nonInteractive && !json) {
    if (templates.length === 0) {
      return (
        <App>
          <StatusMessage variant="info">No templates found</StatusMessage>
        </App>
      );
    }

    const tableData = templates.map((t) => ({
      ID: t.id,
      Name: t.name,
      Updated: t.updatedAt
        ? new Date(t.updatedAt).toLocaleDateString()
        : '\u2014',
    }));

    return (
      <App>
        <Box flexDirection="column" gap={1}>
          <Text bold> {search ? `Search: "${search}"` : 'Templates'}</Text>
          <DataTable data={tableData} columns={['ID', 'Name', 'Updated']} />
          <Text dimColor>{`  Total: ${templates.length} template(s)`}</Text>
        </Box>
      </App>
    );
  }

  // Empty results (interactive)
  if (step === 'done' && templates.length === 0) {
    return (
      <App>
        <StatusMessage variant="info">No templates found</StatusMessage>
      </App>
    );
  }

  // Interactive: template picker
  if (step === 'selectTemplate') {
    const maxNameLen = Math.max(...templates.map((t) => (t.name || 'Untitled').length), 10);
    const items = templates.map((t) => ({
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
          title={search ? `Search: "${search}"` : 'Templates'}
          items={items}
          onSelect={handleTemplateSelect}
          onCancel={handleCancel}
        />
      </App>
    );
  }

  // Interactive: action menu
  if (step === 'templateAction' && selectedTemplateId) {
    return (
      <App>
        <TemplateActions
          templateId={selectedTemplateId}
          templateName={selectedTemplateName}
          projectId={projectId}
          onDone={handleActionDone}
          onCancel={handleActionCancel}
        />
      </App>
    );
  }

  return <></>;
}

export const listTemplatesCommand = new Command('list')
  .description('List templates')
  .option('--json', 'Output as JSON')
  .option('--project-id <id>', 'Filter templates by project ID')
  .option('--limit <n>', 'Maximum number of templates to return', parseInt)
  .option('-s, --search <query>', 'Search templates by name')
  .action((options) => {
    requireAuth();
    const { waitUntilExit } = renderCommand(
      <ListTemplatesCommand
        json={options.json}
        projectId={options.projectId}
        limit={options.limit}
        search={options.search}
      />,
    );
    waitUntilExit().catch((err) => {
      if (err) process.exit(process.exitCode || 1);
    });
  });
