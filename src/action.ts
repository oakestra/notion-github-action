import {Client, LogLevel} from '@notionhq/client/build/src';
import * as core from '@actions/core';
import type {IssuesEvent, IssuesOpenedEvent} from '@octokit/webhooks-definitions/schema';
import type {WebhookPayload} from '@actions/github/lib/interfaces';
import {CustomValueMap, properties} from './properties';
import {createIssueMapping, syncNotionDBWithGitHub} from './sync';
import {Octokit} from 'octokit';
import {markdownToRichText} from '@tryfabric/martian';
import {CustomTypes} from './api-types';
import {CreatePageParameters} from '@notionhq/client/build/src/api-endpoints';

function removeHTML(text?: string): string {
  if (!text) return '';
  // Remove all HTML tags (both paired and self-closing)
  return text
    .replace(/<[^>]+>/g, '')  // Remove all HTML tags
    .replace(/\n\s*\n/g, '\n') // Normalize multiple newlines to single newlines
    .trim();
}

function preprocessMarkdown(text: string): string {
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  
  // Convert heading markdown to bold text (e.g., "## Heading" -> "**Heading**")
  text = text.replace(/^#+\s+(.+)$/gm, '**$1**');
  
  // Handle markdown images [alt](url) by replacing with just the alt text
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1 (image)');
  
  return text;
}

interface PayloadParsingOptions {
  payload: IssuesEvent;
}
async function parsePropertiesFromPayload(options: PayloadParsingOptions): Promise<CustomValueMap> {
  const {payload} = options;

  const result: CustomValueMap = {
    Name: properties.title(payload.issue.title),
    Status: properties.getStatusSelectOption(payload.issue.state!),
    Body: properties.richText(parseBodyRichText(payload.issue.body)),
    Assignees: properties.multiSelect(payload.issue.assignees.map(assignee => assignee.login)),
    Reviewer: properties.multiSelect([]),
    Link: properties.url(payload.issue.html_url),
  };

  return result;
}

export function parseBodyRichText(body: string): CustomTypes.RichText['rich_text'] {
  try {
    const cleanBody = removeHTML(body);
    const processedBody = preprocessMarkdown(cleanBody);
    return markdownToRichText(processedBody) as CustomTypes.RichText['rich_text'];
  } catch (error) {
    core.warning(`Failed to parse markdown: ${error instanceof Error ? error.message : String(error)}`);
    // Fallback: return the text content as plain rich text
    const cleanBody = removeHTML(body);
    if (cleanBody.length > 0) {
      return [
        {
          type: 'text',
          text: {
            content: cleanBody.substring(0, 2000), // Notion has a 2000 char limit per block
          },
          annotations: {
            bold: false,
            strikethrough: false,
            underline: false,
            italic: false,
            code: false,
            color: 'default',
          },
        } as unknown as CustomTypes.RichText['rich_text'][0],
      ];
    }
    return [];
  }
}

function getBodyChildrenBlocks(body: string): Exclude<CreatePageParameters['children'], undefined> {
  // We're currently using only one paragraph block, but this could be extended to multiple kinds of blocks.
  return [
    {
      type: 'paragraph',
      paragraph: {
        text: parseBodyRichText(body),
      },
    },
  ];
}

interface IssueOpenedOptions {
  notion: {
    client: Client;
    databaseId: string;
  };
  payload: IssuesOpenedEvent;
}

async function handleIssueOpened(options: IssueOpenedOptions) {
  const {notion, payload} = options;

  core.info(`Creating page for issue #${payload.issue.number}`);

  await notion.client.pages.create({
    parent: {
      database_id: notion.databaseId,
    },
    properties: await parsePropertiesFromPayload({
      payload,
    }),
    children: getBodyChildrenBlocks(payload.issue.body),
  });
}

interface IssueEditedOptions {
  notion: {
    client: Client;
    databaseId: string;
  };
  payload: IssuesEvent;
}

async function handleIssueEdited(options: IssueEditedOptions) {
  const {notion, payload} = options;

  core.info(`Querying database for page with github id ${payload.issue.id}`);

  const query = await notion.client.databases.query({
    database_id: notion.databaseId,
    filter: {
      property: 'ID',
      number: {
        equals: payload.issue.id,
      },
    },
    page_size: 1,
  });

  const bodyBlocks = getBodyChildrenBlocks(payload.issue.body);

  if (query.results.length > 0) {
    const pageId = query.results[0].id;

    core.info(`Query successful: Page ${pageId}`);
    core.info(`Updating page for issue #${payload.issue.number}`);

    await notion.client.pages.update({
      page_id: pageId,
      properties: await parsePropertiesFromPayload({payload}),
    });

    const existingBlocks = (
      await notion.client.blocks.children.list({
        block_id: pageId,
      })
    ).results;

    const overlap = Math.min(bodyBlocks.length, existingBlocks.length);

    await Promise.all(
      bodyBlocks.slice(0, overlap).map((block, index) =>
        notion.client.blocks.update({
          block_id: existingBlocks[index].id,
          ...block,
        })
      )
    );

    if (bodyBlocks.length > existingBlocks.length) {
      await notion.client.blocks.children.append({
        block_id: pageId,
        children: bodyBlocks.slice(overlap),
      });
    } else if (bodyBlocks.length < existingBlocks.length) {
      await Promise.all(
        existingBlocks
          .slice(overlap)
          .map(block => notion.client.blocks.delete({block_id: block.id}))
      );
    }
  } else {
    core.warning(`Could not find page with github id ${payload.issue.id}, creating a new one`);

    await notion.client.pages.create({
      parent: {
        database_id: notion.databaseId,
      },
      properties: await parsePropertiesFromPayload({payload}),
      children: bodyBlocks,
    });
  }

  const pageId = query.results[0].id;

  core.info(`Query successful: Page ${pageId}`);
  core.info(`Updating page for issue #${payload.issue.number}`);

  await notion.client.pages.update({
    page_id: pageId,
    properties: await parsePropertiesFromPayload({
      payload,
    }),
  });
}

interface Options {
  notion: {
    token: string;
    databaseId: string;
  };
  github: {
    payload: WebhookPayload;
    eventName: string;
    token: string;
  };
}

export async function run(options: Options) {
  const {notion, github} = options;

  core.info('Starting...');
  
  // Validate database ID
  if (!notion.databaseId || notion.databaseId.length === 0) {
    throw new Error('Notion database ID is not configured. Please set the notion-db input parameter.');
  }

  const notionClient = new Client({
    auth: notion.token,
    logLevel: core.isDebug() ? LogLevel.DEBUG : LogLevel.WARN,
  });
  const octokit = new Octokit({auth: github.token});

  if (github.payload.action === 'opened') {
    await handleIssueOpened({
      notion: {
        client: notionClient,
        databaseId: notion.databaseId,
      },
      payload: github.payload as IssuesOpenedEvent,
    });
  } else if (github.eventName === 'workflow_dispatch') {
    try {
      const notion = new Client({auth: options.notion.token});
      const {databaseId} = options.notion;
      core.info(`Using Notion database ID: ${databaseId}`);
      
      const issuePageIds = await createIssueMapping(notion, databaseId);
      if (!github.payload.repository?.full_name) {
        throw new Error('Unable to find repository name in github webhook context');
      }
      const githubRepo = github.payload.repository.full_name;
      await syncNotionDBWithGitHub(issuePageIds, octokit, notion, databaseId, githubRepo);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      core.error(`Workflow dispatch sync failed: ${errorMessage}`);
      throw error;
    }
  } else {
    await handleIssueEdited({
      notion: {
        client: notionClient,
        databaseId: notion.databaseId,
      },
      payload: github.payload as IssuesEvent,
    });
  }

  core.info('Complete!');
}
