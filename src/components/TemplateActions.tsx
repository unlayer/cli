/**
 * Shared action menu shown after selecting a template.
 *
 * Actions:
 *   1. View details   — retrieve + display KeyValue
 *   2. Pull to file   — retrieve + save to ./templates/{name}-{id}.json
 *   3. Open in console — retrieve (for displayMode) + open browser
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select, Spinner, StatusMessage } from '@inkjs/ui';
import { KeyValue } from './KeyValue.js';
import { createSdkClient } from '../lib/sdk-client.js';
import { getDefaultOutputDir, getProjectId } from '../lib/config.js';
import { getTemplateEditorUrl } from '../lib/urls.js';
import { openBrowser } from '../lib/browser.js';
import { sanitizeName } from '../lib/format-option-label.js';
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../lib/errors.js';

interface TemplateData {
  id?: string;
  name?: string;
  displayMode?: string;
  design?: object;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface TemplateActionsProps {
  templateId: string;
  templateName: string;
  projectId?: string;
  onDone: () => void;
  onCancel: () => void;
}

type Step = 'selectAction' | 'executing' | 'done' | 'error';
type Action = 'view' | 'pull' | 'open';

const ACTION_OPTIONS = [
  { label: 'View details', value: 'view' as const },
  { label: 'Pull to file', value: 'pull' as const },
  { label: 'Open in console', value: 'open' as const },
];

export function TemplateActions({
  templateId,
  templateName,
  projectId,
  onDone,
  onCancel,
}: TemplateActionsProps): React.ReactElement {
  const [step, setStep] = useState<Step>('selectAction');
  const [action, setAction] = useState<Action | null>(null);
  const [template, setTemplate] = useState<TemplateData | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape && step === 'selectAction') {
      onCancel();
    }
  });

  // Execute the chosen action
  useEffect(() => {
    if (step !== 'executing' || !action) return;

    const client = createSdkClient();
    const retrieveParams: Record<string, unknown> = {};
    if (projectId) retrieveParams.projectId = projectId;

    (async () => {
      try {
        const response = await client.templates.retrieve(templateId, retrieveParams);
        const tmpl = response.data as TemplateData;
        setTemplate(tmpl);

        if (action === 'view') {
          // Template data is set — render will show KeyValue
          setStep('done');
          return;
        }

        if (action === 'pull') {
          const outputDir = getDefaultOutputDir();
          const resolvedDir = path.resolve(outputDir);
          fs.mkdirSync(resolvedDir, { recursive: true });

          const name = tmpl.name || templateName || 'untitled';
          const safeName = sanitizeName(name);
          const filename = `${safeName}-${templateId}.json`;
          const filePath = path.join(resolvedDir, filename);

          const envelope = {
            id: tmpl.id,
            name: tmpl.name,
            displayMode: tmpl.displayMode,
            design: tmpl.design,
            createdAt: tmpl.createdAt,
            updatedAt: tmpl.updatedAt,
          };
          fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2));

          const relativePath = path.relative(process.cwd(), filePath) || filePath;
          setResultMessage(`Saved to ${relativePath}`);
          setStep('done');
          return;
        }

        if (action === 'open') {
          const pid = projectId || getProjectId();
          if (!pid) {
            setError('No project ID configured. Set one with `unlayer project use <id>` or pass --project-id.');
            setStep('error');
            return;
          }
          const url = getTemplateEditorUrl(pid, templateId, tmpl.displayMode);
          const opened = await openBrowser(url);
          if (opened) {
            setResultMessage(`Opened in browser: ${url}`);
          } else {
            setResultMessage(`Open this URL in your browser:\n  ${url}`);
          }
          setStep('done');
          return;
        }
      } catch (err) {
        setError(errorMessage(err, 'Action failed'));
        setStep('error');
      }
    })();
  }, [step, action, templateId, templateName, projectId]);

  // Notify parent after result is rendered
  useEffect(() => {
    if (step === 'done' || step === 'error') {
      const timer = setTimeout(() => onDone(), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, onDone]);

  const handleActionSelect = (value: string) => {
    setAction(value as Action);
    setStep('executing');
  };

  // ── Render ──────────────────────────────────────────────

  if (step === 'selectAction') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{'  '}{templateName} <Text dimColor>(ID: {templateId})</Text></Text>
        <Select options={ACTION_OPTIONS} onChange={handleActionSelect} />
        <Text dimColor>{'  '}esc back  |  enter select</Text>
      </Box>
    );
  }

  if (step === 'executing') {
    return <Spinner label={`Running action on "${templateName}"...`} />;
  }

  if (step === 'error' && error) {
    return (
      <Box flexDirection="column" gap={1}>
        <StatusMessage variant="error">{error}</StatusMessage>
      </Box>
    );
  }

  if (step === 'done') {
    // View details
    if (action === 'view' && template) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{'  '}Template: {template.name}</Text>
          <KeyValue
            pairs={[
              { key: 'ID', value: template.id },
              { key: 'Name', value: template.name },
              { key: 'Display Mode', value: template.displayMode },
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
        </Box>
      );
    }

    // Pull / Open result
    if (resultMessage) {
      return (
        <Box flexDirection="column" gap={1}>
          <StatusMessage variant="success">{resultMessage}</StatusMessage>
        </Box>
      );
    }
  }

  return <></>;
}
