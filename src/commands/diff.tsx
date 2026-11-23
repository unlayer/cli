import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Command } from 'commander';
import { App } from '../components/App.js';
import { createSdkClient } from '../lib/sdk-client.js';
import { requireAuth } from '../lib/config.js';
import { renderCommand, jsonError, stdoutWrite } from '../lib/render.js';
import { isJsonMode } from '../lib/cli-flags.js';
import { diffDesigns, type DesignDiffResult } from '../lib/design-diff.js';
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../lib/errors.js';

type Step = 'loadLocal' | 'fetchRemote' | 'diffing' | 'display' | 'error';

interface DiffCommandProps {
  localFile: string;
  remote?: string;
  projectId?: string;
  json?: boolean;
}

/**
 * Try to auto-detect the remote template ID from a local file.
 *
 * Strategy:
 * 1. Check the file content for a top-level `id` field (from pull envelope format)
 * 2. Fall back to filename pattern: `{name}-{id}.json` -> extract trailing id segment
 */
function detectTemplateId(filePath: string, fileContent: object): string | null {
  // 1. Check top-level "id" field (pull envelope)
  const envelope = fileContent as { id?: string | number };
  if (envelope.id !== undefined && envelope.id !== null) {
    return String(envelope.id);
  }

  // 2. Filename pattern: {name}-{id}.json
  const basename = path.basename(filePath, '.json');
  const match = basename.match(/-(\d+)$/);
  if (match) {
    return match[1];
  }

  return null;
}

function DiffCommand({
  localFile,
  remote: remoteFlag,
  projectId,
  json: jsonProp,
}: DiffCommandProps): React.ReactElement {
  const json = jsonProp || isJsonMode();
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('loadLocal');
  const [localDesign, setLocalDesign] = useState<object | null>(null);
  const [templateId, setTemplateId] = useState<string>(remoteFlag || '');
  const [templateName, setTemplateName] = useState<string>('');
  const [diffResult, setDiffResult] = useState<DesignDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Step 1: Load local file
  useEffect(() => {
    if (step !== 'loadLocal') return;

    const filePath = path.resolve(localFile);
    if (!fs.existsSync(filePath)) {
      setError(`File not found: ${filePath}`);
      setStep('error');
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);

      // Extract design — handle both envelope format and raw design
      const design = parsed.design || parsed;
      if (!design.body) {
        setError('Invalid design file: missing "body" property. File should be a design JSON or a pull envelope.');
        setStep('error');
        return;
      }

      setLocalDesign(design);

      // Capture template name from envelope
      if (parsed.name) {
        setTemplateName(parsed.name);
      }

      // Auto-detect remote template ID
      if (!remoteFlag) {
        const detectedId = detectTemplateId(filePath, parsed);
        if (!detectedId) {
          setError(
            'Cannot auto-detect remote template ID. Use --remote <id> to specify it, or ensure the file was created by `unlayer pull`.',
          );
          setStep('error');
          return;
        }
        setTemplateId(detectedId);
      }

      setStep('fetchRemote');
    } catch (err) {
      setError(
        `Failed to parse ${localFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
      setStep('error');
    }
  }, [step, localFile, remoteFlag]);

  // Step 2: Fetch remote template
  useEffect(() => {
    if (step !== 'fetchRemote' || !templateId) return;

    const client = createSdkClient(undefined, undefined, projectId ? Number(projectId) : undefined);
    const retrieveParams: Record<string, unknown> = {};
    if (projectId) retrieveParams.projectId = projectId;

    client.templates
      .retrieve(templateId, retrieveParams)
      .then((response) => {
        const tmpl = response.data as { design?: object; name?: string };
        if (!tmpl.design) {
          setError(`Remote template #${templateId} has no design data.`);
          setStep('error');
          return;
        }

        if (tmpl.name && !templateName) {
          setTemplateName(tmpl.name);
        }

        // Step 3: Compute diff
        const result = diffDesigns(localDesign!, tmpl.design, {
          templateId,
          templateName: templateName || tmpl.name,
        });

        setDiffResult(result);
        setStep('display');
      })
      .catch((err) => {
        setError(errorMessage(err, String(err), `Failed to fetch remote template #${templateId}: `));
        setStep('error');
      });
  }, [step, templateId, localDesign, projectId, templateName]);

  // Step 4: Display results
  useEffect(() => {
    if (step !== 'display' || !diffResult) return;

    if (json) {
      stdoutWrite(JSON.stringify(diffResult, null, 2));
    }

    const timer = setTimeout(() => exit(), 100);
    return () => clearTimeout(timer);
  }, [step, diffResult, json, exit]);

  // Error exit
  useEffect(() => {
    if (step === 'error' && error) {
      jsonError(error);
      const timer = setTimeout(() => exit(new Error(error)), 100);
      return () => clearTimeout(timer);
    }
    return;
  }, [step, error, exit]);

  if (step === 'loadLocal') {
    return (
      <App>
        <Spinner label="Loading local file..." />
      </App>
    );
  }

  if (step === 'fetchRemote') {
    return (
      <App>
        <Spinner label={`Fetching remote template #${templateId}...`} />
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

  if (step === 'display' && diffResult && !json) {
    if (diffResult.totalChanges === 0) {
      return (
        <App>
          <StatusMessage variant="success">
            {`No differences found between ${path.basename(localFile)} and remote #${templateId}`}
          </StatusMessage>
        </App>
      );
    }

    // Group changes by section
    const settingsChanges = diffResult.changes.filter((c) => c.section === 'settings');
    const rowChanges = diffResult.changes.filter((c) => c.section === 'rows');
    const contentChanges = diffResult.changes.filter((c) => c.section === 'content');

    const typeSymbol = (type: string) => {
      switch (type) {
        case 'added': return '+';
        case 'removed': return '-';
        case 'changed': return '~';
        default: return ' ';
      }
    };

    const typeColor = (type: string) => {
      switch (type) {
        case 'added': return 'green';
        case 'removed': return 'red';
        case 'changed': return 'yellow';
        default: return 'white';
      }
    };

    // Build summary string
    const parts: string[] = [];
    if (diffResult.summary.settingsChanged > 0) {
      parts.push(`${diffResult.summary.settingsChanged} setting(s)`);
    }
    const rowTotal = diffResult.summary.rowsAdded + diffResult.summary.rowsRemoved + diffResult.summary.rowsChanged;
    if (rowTotal > 0) {
      const rowParts: string[] = [];
      if (diffResult.summary.rowsAdded > 0) rowParts.push(`${diffResult.summary.rowsAdded} added`);
      if (diffResult.summary.rowsRemoved > 0) rowParts.push(`${diffResult.summary.rowsRemoved} removed`);
      if (diffResult.summary.rowsChanged > 0) rowParts.push(`${diffResult.summary.rowsChanged} changed`);
      parts.push(`${rowTotal} row(s) (${rowParts.join(', ')})`);
    }
    const contentTotal = diffResult.summary.contentAdded + diffResult.summary.contentRemoved + diffResult.summary.contentChanged;
    if (contentTotal > 0) {
      parts.push(`${contentTotal} content change(s)`);
    }

    return (
      <App>
        <Box flexDirection="column" gap={1}>
          <Text bold>
            {`  Diff: ${path.basename(localFile)} <-> Remote #${templateId}`}
            {templateName ? ` (${templateName})` : ''}
          </Text>

          {settingsChanges.length > 0 && (
            <Box flexDirection="column">
              <Text bold dimColor>{'  Body Settings'}</Text>
              {settingsChanges.map((c, i) => (
                <Text key={`s-${i}`} color={typeColor(c.type)}>
                  {`    ${typeSymbol(c.type)} ${c.path.replace('Body Settings > ', '')}: ${c.details || ''}`}
                </Text>
              ))}
            </Box>
          )}

          {rowChanges.length > 0 && (
            <Box flexDirection="column">
              <Text bold dimColor>{'  Rows'}</Text>
              {rowChanges.map((c, i) => (
                <Text key={`r-${i}`} color={typeColor(c.type)}>
                  {`    ${typeSymbol(c.type)} ${c.path}${c.details ? `: ${c.details}` : ''}`}
                </Text>
              ))}
            </Box>
          )}

          {contentChanges.length > 0 && (
            <Box flexDirection="column">
              <Text bold dimColor>{'  Content'}</Text>
              {contentChanges.map((c, i) => (
                <Text key={`c-${i}`} color={typeColor(c.type)}>
                  {`    ${typeSymbol(c.type)} ${c.path}${c.details ? `: ${c.details}` : ''}`}
                </Text>
              ))}
            </Box>
          )}

          <Text dimColor>
            {`  Summary: ${parts.join(', ')} (${diffResult.totalChanges} total)`}
          </Text>
        </Box>
      </App>
    );
  }

  return <></>;
}

export const diffCommand = new Command('diff')
  .description('Compare a local design file against its remote template')
  .argument('<local-file>', 'Path to local design JSON file')
  .option('--remote <id>', 'Remote template ID (auto-detected from file if omitted)')
  .option('--project-id <id>', 'Project ID to scope the template lookup')
  .option('--json', 'Output diff as structured JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ unlayer diff ./templates/welcome-email-1.json           # Auto-detect remote ID
  $ unlayer diff ./local.json --remote 42                   # Explicit remote ID
  $ unlayer diff ./local.json --json 2>/dev/null            # Structured JSON diff
`,
  )
  .action((localFile, options) => {
    requireAuth();
    const { waitUntilExit } = renderCommand(
      <DiffCommand
        localFile={localFile}
        remote={options.remote}
        projectId={options.projectId}
        json={options.json}
      />,
    );
    waitUntilExit().catch((err) => {
      if (err) process.exit(process.exitCode || 1);
    });
  });
