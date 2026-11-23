/**
 * `unlayer template search <query>` — search templates by name.
 *
 * Convenience wrapper around `template list --search`. In interactive mode
 * the results are shown as a selectable list with a post-selection action menu.
 */

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
  displayMode?: string;
  updatedAt?: string;
}

type Step = 'loading' | 'selectTemplate' | 'templateAction' | 'done' | 'cancelled' | 'error';

interface SearchTemplatesCommandProps {
  query: string;
  json?: boolean;
  projectId?: string;
  limit?: number;
}

function SearchTemplatesCommand({
  query,
  json: jsonProp,
  projectId,
  limit,
}: SearchTemplatesCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const nonInteractive = json || isNonInteractive();
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('loading');
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [selectedTemplateName, setSelectedTemplateName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Load search results
  useEffect(() => {
    if (step !== 'loading') return;

    const client = createSdkClient();
    const listParams: Record<string, unknown> = { name: query };
    if (projectId) listParams.projectId = projectId;

    (async () => {
      try {
        const results: TemplateItem[] = [];
        for await (const t of client.templates.list(listParams)) {
          results.push(t as TemplateItem);
          if (limit && results.length >= limit) break;
        }
        setTemplates(results);

        if (nonInteractive) {
          setStep('done');
        } else if (results.length === 0) {
          setStep('done');
        } else {
          setStep('selectTemplate');
        }
      } catch (err) {
        setError(errorMessage(err, 'Search failed'));
        setStep('error');
      }
    })();
  }, [step, query, projectId, limit, nonInteractive]);

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
        <Spinner label={`Searching for "${query}"...`} />
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
          <StatusMessage variant="info">
            {`No templates matching "${query}"`}
          </StatusMessage>
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
          <Text bold>{` Search: "${query}"`}</Text>
          <DataTable data={tableData} columns={['ID', 'Name', 'Updated']} />
          <Text dimColor>{`  ${templates.length} result(s)`}</Text>
        </Box>
      </App>
    );
  }

  // Empty results (interactive)
  if (step === 'done' && templates.length === 0) {
    return (
      <App>
        <StatusMessage variant="info">
          {`No templates matching "${query}"`}
        </StatusMessage>
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
          title={`Search: "${query}"`}
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

export const searchTemplatesCommand = new Command('search')
  .description('Search templates by name')
  .argument('<query>', 'Search query (case-insensitive name match)')
  .option('--json', 'Output as JSON')
  .option('--project-id <id>', 'Filter by project ID')
  .option('--limit <n>', 'Maximum number of results', parseInt)
  .action((query, options) => {
    requireAuth();
    const { waitUntilExit } = renderCommand(
      <SearchTemplatesCommand
        query={query}
        json={options.json}
        projectId={options.projectId}
        limit={options.limit}
      />,
    );
    waitUntilExit().catch((err) => {
      if (err) process.exit(process.exitCode || 1);
    });
  });
