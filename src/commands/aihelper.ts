/*
 * Copyright (c) 2022, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';
import { Flags, loglevel, orgApiVersionFlagWithDeprecations, SfCommand } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core/messages';
import MiniSearch from 'minisearch';

const readdir = promisify(fs.readdir);

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-aihelper', 'ai_aihelper');

// Simplified type definitions
type MessageSection = {
  key: string;
  content: string;
};

type MessageFile = {
  filename: string;
  pluginName: string;
  messageKey: string;
  sections: MessageSection[];
  fullContent: string;
};

type RAGContext = {
  relevantMessages: MessageFile[];
  searchQuery: string;
  confidence: number;
};

type CommandExecution = {
  command: string;
  output: string;
  success: boolean;
  timestamp: Date;
};

type CommandDetection = {
  hasCommand: boolean;
  command?: string;
  description?: string;
};

type PlaceholderInfo = {
  placeholder: string;
  value: string;
};

type PluginInfo = {
  name: string;
  messageKeys: string[];
};

// Simplified AI types - we only need what we actually use
type AiMessage = {
  role: string;
  content: string;
};

type AiResponse = {
  id: string;
  generationDetails: {
    generations: Array<{
      content: string;
      role: string;
    }>;
  };
};

/**
 * Search service using MiniSearch for better full-text search capabilities
 */
class SearchService {
  private miniSearch: MiniSearch<MessageFile>;
  private isIndexed: boolean = false;

  public constructor() {
    this.miniSearch = new MiniSearch({
      fields: ['pluginName', 'messageKey', 'fullContent', 'sectionsText'],
      storeFields: ['pluginName', 'messageKey', 'sections', 'fullContent', 'filename'],
      searchOptions: {
        boost: { pluginName: 2, messageKey: 3 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: 'OR',
      },
    });
  }

  /**
   * Expand query terms to include common variations and related terms
   */
  private static expandQueryTerms(query: string): string {
    const expansions: Record<string, string[]> = {
      package: ['packaging', 'packages'],
      packages: ['packaging', 'package'],
      packaging: ['package', 'packages'],
      deploy: ['deployment', 'retrieve'],
      deployment: ['deploy', 'retrieve'],
      org: ['organization', 'orgs'],
      orgs: ['organization', 'org'],
      auth: ['authentication', 'authorize', 'login'],
      login: ['auth', 'authentication', 'authorize'],
      data: ['import', 'export', 'query'],
      apex: ['class', 'trigger'],
      user: ['users', 'permission', 'profile'],
      list: ['show', 'display', 'get'],
      create: ['new', 'generate', 'make'],
      delete: ['remove', 'destroy'],
    };

    let expandedTerms = query;
    for (const [key, values] of Object.entries(expansions)) {
      if (query.toLowerCase().includes(key)) {
        expandedTerms += ' ' + values.join(' ');
      }
    }

    return expandedTerms;
  }

  /**
   * Index all message files for search
   */
  public indexMessages(messageFiles: MessageFile[]): void {
    if (this.isIndexed) {
      this.miniSearch.removeAll();
    }

    const documentsToIndex = messageFiles.map((message, index) => ({
      id: index,
      pluginName: message.pluginName,
      messageKey: message.messageKey,
      filename: message.filename,
      sections: message.sections,
      fullContent: message.fullContent,
      sectionsText: message.sections.map((s) => `${s.key} ${s.content}`).join(' '),
    }));

    this.miniSearch.addAll(documentsToIndex);
    this.isIndexed = true;
  }

  /**
   * Search for relevant messages using MiniSearch
   */
  public search(query: string, limit: number = 10): Array<{ message: MessageFile; score: number }> {
    if (!this.isIndexed) {
      return [];
    }

    // Expand query terms for better matching
    const expandedQuery = SearchService.expandQueryTerms(query);

    try {
      const results = this.miniSearch.search(expandedQuery, {
        combineWith: 'OR',
        fuzzy: 0.2,
        prefix: true,
      });

      return results.slice(0, limit).map((result) => ({
        message: {
          pluginName: result.pluginName as string,
          messageKey: result.messageKey as string,
          filename: result.filename as string,
          sections: result.sections as MessageSection[],
          fullContent: result.fullContent as string,
        },
        score: result.score,
      }));
    } catch (error) {
      // Fallback to simple search if complex query fails
      try {
        const simpleResults = this.miniSearch.search(query, {
          combineWith: 'OR',
        });

        return simpleResults.slice(0, limit).map((result) => ({
          message: {
            pluginName: result.pluginName as string,
            messageKey: result.messageKey as string,
            filename: result.filename as string,
            sections: result.sections as MessageSection[],
            fullContent: result.fullContent as string,
          },
          score: result.score,
        }));
      } catch (fallbackError) {
        return [];
      }
    }
  }

  /**
   * Clear the search index
   */
  public clearIndex(): void {
    this.miniSearch.removeAll();
    this.isIndexed = false;
  }
}

/**
 * Utility class for handling message files and text processing
 */
class MessageProcessor {
  /**
   * Parse a message file into structured sections
   */
  public static parseMessageFile(pluginName: string, messageKey: string, content: string): MessageFile {
    const sections: MessageSection[] = [];
    const lines = content.split('\n');
    let currentSection: MessageSection | null = null;

    for (const line of lines) {
      if (line.startsWith('# ')) {
        if (currentSection) {
          sections.push(currentSection);
        }
        currentSection = { key: line.substring(2).trim(), content: '' };
      } else if (currentSection) {
        currentSection.content += line + '\n';
      }
    }

    if (currentSection) {
      sections.push(currentSection);
    }

    return {
      filename: `${messageKey}.md`,
      pluginName,
      messageKey,
      sections,
      fullContent: content,
    };
  }

  /**
   * Create enhanced prompt with retrieved documentation
   */
  public static createEnhancedPrompt(query: string, ragContext: RAGContext): string {
    let prompt = `Based on the following Salesforce CLI documentation, please answer: '${query}'\n\n`;
    prompt += 'RELEVANT DOCUMENTATION:\n' + '='.repeat(50) + '\n\n';

    for (const message of ragContext.relevantMessages) {
      prompt += `## ${message.pluginName} - ${message.messageKey.replace(/_/g, ' ')}\n\n`;

      for (const section of message.sections) {
        if (section.content.trim()) {
          prompt += `**${section.key}:**\n${section.content.trim()}\n\n`;
        }
      }
      prompt += '---\n\n';
    }

    prompt +=
      '\nPlease provide a comprehensive answer based on this documentation. Include specific command examples with proper syntax when relevant.';
    return prompt;
  }
}

/**
 * Utility class for discovering and loading Salesforce CLI plugin messages
 */
class PluginMessageLoader {
  private static readonly KNOWN_PLUGINS: string[] = [
    '@salesforce/packaging',
    '@salesforce/plugin-packaging',
    '@salesforce/plugin-data',
    '@salesforce/plugin-org',
    '@salesforce/plugin-auth',
    '@salesforce/plugin-deploy-retrieve',
    '@salesforce/plugin-apex',
    '@salesforce/plugin-sobject',
    '@salesforce/plugin-limits',
    '@salesforce/plugin-trust',
    '@salesforce/plugin-settings',
    '@salesforce/plugin-templates',
    '@salesforce/plugin-user',
    '@salesforce/plugin-info',
    '@salesforce/plugin-api',
    '@salesforce/plugin-schema',
    '@salesforce/plugin-marketplace',
    '@salesforce/plugin-telemetry',
    '@salesforce/plugin-dev',
  ];

  /**
   * Discover available plugins with message files
   */
  public static async discoverPlugins(): Promise<PluginInfo[]> {
    const plugins: PluginInfo[] = [];

    // Process plugins sequentially to avoid overwhelming the filesystem
    for (const pluginName of this.KNOWN_PLUGINS) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const messageKeys = await this.discoverMessageKeys(pluginName);
        if (messageKeys.length > 0) {
          plugins.push({ name: pluginName, messageKeys });
        }
      } catch (error) {
        // Plugin might not be installed or have messages - silently continue
      }
    }

    return plugins;
  }

  /**
   * Load a specific message file using direct file reading
   */
  public static async loadPluginMessage(pluginName: string, messageKey: string): Promise<string | null> {
    // Try to read the message file directly from the filesystem
    const possiblePaths = [
      `/usr/local/lib/sf/node_modules/${pluginName}/messages/${messageKey}.md`,
      `/usr/local/lib/sf/node_modules/${pluginName}/lib/messages/${messageKey}.md`,
      `/usr/local/lib/node_modules/${pluginName}/messages/${messageKey}.md`,
      `./node_modules/${pluginName}/messages/${messageKey}.md`,
      `./node_modules/${pluginName}/lib/messages/${messageKey}.md`,
    ];

    for (const filePath of possiblePaths) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const content = await fs.promises.readFile(filePath, 'utf8');
        if (content.trim()) {
          return content;
        }
      } catch (error) {
        // File doesn't exist at this path, try next one
        continue;
      }
    }

    // Fallback: try the Messages API approach as last resort
    try {
      const loadedMessages = Messages.loadMessages(pluginName, messageKey);
      return this.extractContentFromMessagesAPI(loadedMessages, pluginName, messageKey);
    } catch (error) {
      return null;
    }
  }

  /**
   * Discover message keys for a specific plugin by checking the filesystem
   */
  private static async discoverMessageKeys(pluginName: string): Promise<string[]> {
    const messageKeys: string[] = [];

    // Try to find the plugin's messages directory
    const possiblePaths = [
      `/usr/local/lib/sf/node_modules/${pluginName}/messages`,
      `/usr/local/lib/sf/node_modules/${pluginName}/lib/messages`,
      `/usr/local/lib/node_modules/${pluginName}/messages`,
      `./node_modules/${pluginName}/messages`,
      `./node_modules/${pluginName}/lib/messages`,
    ];

    for (const messagesPath of possiblePaths) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const files = await readdir(messagesPath);
        const mdFiles = files.filter((file) => file.endsWith('.md')).map((file) => file.replace('.md', ''));

        messageKeys.push(...mdFiles);
        break; // Found the directory, stop looking
      } catch (error) {
        // Directory doesn't exist, try next path
        continue;
      }
    }

    return [...new Set(messageKeys)]; // Remove duplicates
  }

  /**
   * Fallback method to extract content from Messages API
   */
  private static extractContentFromMessagesAPI(
    loadedMessages: Messages<string>,
    pluginName: string,
    messageKey: string
  ): string | null {
    try {
      // Try to get common message keys that are likely to exist
      const commonKeys = [
        'summary',
        'description',
        'examples',
        'help',
        `${messageKey}.summary`,
        `${messageKey}.description`,
      ];

      let content = '';
      for (const key of commonKeys) {
        try {
          const message = loadedMessages.getMessage(key);
          if (message?.trim()) {
            content += `# ${key}\n\n${message}\n\n`;
          }
        } catch (error) {
          continue;
        }
      }

      // If we found some content, return it
      if (content.trim()) {
        return content;
      }

      // Try to inspect the object structure to find any available messages
      const messageBundle = loadedMessages as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(messageBundle)) {
        if (typeof value === 'string' && value.trim()) {
          content += `# ${key}\n\n${value}\n\n`;
        } else if (typeof value === 'object' && value !== null) {
          const nestedObj = value as Record<string, unknown>;
          for (const [nestedKey, nestedValue] of Object.entries(nestedObj)) {
            if (typeof nestedValue === 'string' && nestedValue.trim()) {
              content += `# ${nestedKey}\n\n${nestedValue}\n\n`;
            }
          }
        }
      }

      return content.trim() || null;
    } catch (error) {
      return null;
    }
  }
}

/**
 * Utility class for handling command detection and execution
 */
class CommandProcessor {
  /**
   * Extract command from AI response if present
   */
  public static extractCommand(aiResponse: string): CommandDetection {
    // Look for commands in code blocks first, then single backticks
    const codeBlockMatch = aiResponse.match(/```(?:bash|sh|shell|cli)?\s*\n?(.*?)\n?```/s);
    const singleBacktickMatch = aiResponse.match(/`([^`]+)`/);

    const match = codeBlockMatch ?? singleBacktickMatch;
    if (!match) return { hasCommand: false };

    const command = match[1].trim();

    // Only consider it a command if it looks like an sf command
    if (!command.startsWith('sf ') && !command.includes('--')) {
      return { hasCommand: false };
    }

    return {
      hasCommand: true,
      command,
      description: this.extractCommandDescription(aiResponse, match[0]),
    };
  }

  /**
   * Extract placeholders from command
   */
  public static extractPlaceholders(command: string): string[] {
    const matches = command.match(/<([^>]+)>/g);
    return matches ? [...new Set(matches.map((match) => match.slice(1, -1)))] : [];
  }

  /**
   * Replace placeholders in command with user values
   */
  public static replacePlaceholders(command: string, placeholderValues: PlaceholderInfo[]): string {
    return placeholderValues.reduce((cmd, { placeholder, value }) => {
      const regex = new RegExp(`<${placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'g');
      return cmd.replace(regex, value);
    }, command);
  }

  /**
   * Check if input indicates user wants to exit
   */
  public static isExitCommand(input: string): boolean {
    return /\b(exit|quit|bye|goodbye)\b/i.test(input.trim());
  }

  private static extractCommandDescription(response: string, commandText: string): string {
    const lines = response.split('\n');
    const commandLineIndex = lines.findIndex((line) => line.includes(commandText));

    if (commandLineIndex > 0 && lines[commandLineIndex - 1].trim()) {
      return lines[commandLineIndex - 1].trim();
    }
    if (commandLineIndex < lines.length - 1 && lines[commandLineIndex + 1].trim()) {
      return lines[commandLineIndex + 1].trim();
    }

    return 'Execute the suggested command';
  }
}

/**
 * Service for interacting with Einstein AI
 */
class AiService {
  public constructor(private token: string, private location?: string) {}

  public async generateResponse(aiMessages: AiMessage[]): Promise<string> {
    const url =
      this.location ??
      'https://test.api.salesforce.com/einstein/platform/v1/models/sfdc_ai__DefaultOpenAIGPT4OmniMini/chat-generations';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'x-client-feature-id': 'ai-platform-models-connected-app',
        'x-client-trace-id': 'jjtestGPT1',
        'x-sfdc-app-context': 'EinsteinGPT',
      },
      body: JSON.stringify({ messages: aiMessages }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI service request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = (await response.json()) as AiResponse;

    // Simple validation - just check if we have the content we need
    const content = data?.generationDetails?.generations?.[0]?.content;
    if (!content) {
      throw new Error('Invalid response: Missing content in AI response');
    }

    return content;
  }
}

export class PackageAiHelperCommand extends SfCommand<void> {
  public static readonly id = 'aihelper';
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly flags = {
    loglevel,
    'api-version': orgApiVersionFlagWithDeprecations,
    token: Flags.string({
      char: 't',
      summary: messages.getMessage('flags.token.summary'),
      description: messages.getMessage('flags.token.description'),
      required: true,
    }),
    location: Flags.string({
      char: 'l',
      summary: messages.getMessage('flags.location.summary'),
      description: messages.getMessage('flags.location.description'),
      required: false,
    }),
    verbose: Flags.boolean({
      char: 'v',
      summary: messages.getMessage('flags.verbose.summary'),
      description: messages.getMessage('flags.verbose.description'),
      default: false,
    }),
  };

  private messageCache: MessageFile[] = [];
  private commandHistory: CommandExecution[] = [];
  private aiService!: AiService;
  private searchService: SearchService = new SearchService();
  private isVerbose: boolean = false;

  public async run(): Promise<void> {
    const { flags } = await this.parse(PackageAiHelperCommand);

    this.isVerbose = flags.verbose;

    this.aiService = new AiService(flags.token, flags.location);

    const chatMessages: AiMessage[] = [{ role: 'system', content: messages.getMessage('prompt-system') }];

    if (!this.isVerbose) {
      this.log(messages.getMessage('prompt-initial'));
    }
    await this.startInteractiveChat(chatMessages);
  }

  /**
   * Load and cache all message files from Salesforce CLI plugins
   */
  private async loadAllMessages(): Promise<MessageFile[]> {
    if (this.messageCache.length > 0) {
      return this.messageCache;
    }

    const allMessages: MessageFile[] = [];
    let totalPluginsFound = 0;
    let totalMessageKeysFound = 0;
    let successfullyLoaded = 0;

    try {
      if (this.isVerbose) {
        this.log('🔍 Discovering Salesforce CLI plugins...');
      }
      const plugins = await PluginMessageLoader.discoverPlugins();
      totalPluginsFound = plugins.length;
      if (this.isVerbose) {
        this.log(`Found ${plugins.length} plugins with message files`);
      }

      // Process all plugins and their messages in parallel
      const pluginPromises = plugins.map(async (plugin) => {
        totalMessageKeysFound += plugin.messageKeys.length;

        const messagePromises = plugin.messageKeys.map(async (messageKey) => {
          try {
            const content = await PluginMessageLoader.loadPluginMessage(plugin.name, messageKey);
            if (content?.trim()) {
              const messageFile = MessageProcessor.parseMessageFile(plugin.name, messageKey, content);
              return {
                success: true as const,
                messageFile,
                plugin: plugin.name,
                messageKey,
              };
            } else {
              return {
                success: false as const,
                error: 'Empty content',
                plugin: plugin.name,
                messageKey,
              };
            }
          } catch (error) {
            return {
              success: false as const,
              error: error instanceof Error ? error.message : String(error),
              plugin: plugin.name,
              messageKey,
            };
          }
        });

        const results = await Promise.allSettled(messagePromises);

        return {
          plugin,
          results,
        };
      });

      const allPluginResults = await Promise.allSettled(pluginPromises);

      for (const pluginResult of allPluginResults) {
        if (pluginResult.status === 'fulfilled') {
          const { plugin, results } = pluginResult.value;
          if (this.isVerbose) {
            this.log(`   📄 ${plugin.name}: ${plugin.messageKeys.length} message files`);
          }

          for (const result of results) {
            if (result.status === 'fulfilled') {
              if (result.value.success) {
                allMessages.push(result.value.messageFile);
                successfullyLoaded++;
              } else if (this.isVerbose) {
                this.warn(`   ⚠️  ${result.value.error} for ${result.value.plugin}/${result.value.messageKey}`);
              }
            } else if (this.isVerbose) {
              this.warn(`   ❌ Promise rejected: ${String(result.reason)}`);
            }
          }
        } else if (this.isVerbose) {
          this.warn(`   ❌ Plugin processing failed: ${String(pluginResult.reason)}`);
        }
      }
    } catch (error) {
      if (this.isVerbose) {
        this.warn(`Failed to discover plugins: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.messageCache = allMessages;
    if (this.isVerbose) {
      this.log(
        `📚 Successfully loaded ${successfullyLoaded}/${totalMessageKeysFound} message files from ${totalPluginsFound} plugins`
      );

      // If we found plugins but loaded no messages, provide troubleshooting info
      if (totalPluginsFound > 0 && successfullyLoaded === 0) {
        this.log('⚠️  No message content was loaded. This could be due to:');
        this.log('   - Message files not being properly installed');
        this.log('   - Different plugin installation paths');
        this.log('   - Messages API format changes');
        this.log('   Try running with --verbose flag to see detailed debug information');
      }
    }

    return allMessages;
  }

  /**
   * Retrieve relevant messages using RAG approach with MiniSearch
   */
  private async retrieveRelevantMessages(query: string, topK: number = 10): Promise<RAGContext> {
    const allMessages = await this.loadAllMessages();

    // Index messages if not already indexed
    this.searchService.indexMessages(allMessages);

    // Use MiniSearch to find relevant messages
    const searchResults = this.searchService.search(query, topK);

    return {
      relevantMessages: searchResults.map((result) => result.message),
      searchQuery: query,
      confidence: searchResults[0]?.score ?? 0,
    };
  }

  /**
   * Execute a system command and capture output
   */
  private async executeCommand(command: string): Promise<CommandExecution> {
    return new Promise((resolve) => {
      const cleanedCommand = command.replace(/\r?\n/g, ' ').trim().replace(/\s+/g, ' ');
      const [cmd, ...args] = cleanedCommand.split(' ');

      this.log(messages.getMessage('prompt-command-executing', [cleanedCommand]));

      let output = '';
      let errorOutput = '';

      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: true });

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        process.stdout.write(chunk);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        errorOutput += chunk;
        process.stderr.write(chunk);
      });

      child.on('close', (code) => {
        const success = code === 0;
        const execution: CommandExecution = {
          command: cleanedCommand,
          output: success ? output : errorOutput,
          success,
          timestamp: new Date(),
        };

        this.commandHistory.push(execution);

        if (success) {
          this.log('\n' + messages.getMessage('prompt-command-success'));
        } else {
          this.log('\n' + messages.getMessage('prompt-command-error', [errorOutput || 'Unknown error']));
        }

        resolve(execution);
      });

      child.on('error', (error) => {
        const execution: CommandExecution = {
          command: cleanedCommand,
          output: error.message,
          success: false,
          timestamp: new Date(),
        };

        this.commandHistory.push(execution);
        this.log('\n' + messages.getMessage('prompt-command-error', [error.message]));
        resolve(execution);
      });
    });
  }

  /**
   * Prompt user for placeholder values
   */
  private async promptForPlaceholders(
    placeholders: string[],
    askQuestion: (prompt: string) => Promise<string>
  ): Promise<PlaceholderInfo[]> {
    this.log('\n📝 This command contains placeholders that need to be filled in:');

    const values: PlaceholderInfo[] = [];
    for (const placeholder of placeholders) {
      // eslint-disable-next-line no-await-in-loop
      const value = await askQuestion(`\n🔸 Enter value for <${placeholder}>: `);
      values.push({ placeholder, value: value.trim() });

      if (!value.trim()) {
        this.log(`⚠️  Warning: Empty value provided for <${placeholder}>`);
      }
    }

    return values;
  }

  /**
   * Handle command execution with placeholder processing
   */
  private async handleCommandExecution(
    detection: CommandDetection,
    askQuestion: (prompt: string) => Promise<string>
  ): Promise<string | null> {
    if (!detection.hasCommand || !detection.command) return null;

    let finalCommand = detection.command;
    const placeholders = CommandProcessor.extractPlaceholders(detection.command);

    // Handle placeholders if present
    if (placeholders.length > 0) {
      this.log(
        `\n🔧 Command contains ${placeholders.length} placeholder(s): ${placeholders.map((p) => `<${p}>`).join(', ')}`
      );

      const proceed = await askQuestion(
        '\nWould you like to provide values for the placeholders and execute the command? (y/n): '
      );
      if (!['y', 'yes'].includes(proceed.toLowerCase().trim())) {
        this.log('❌ Command execution cancelled due to placeholders.');
        return null;
      }

      const values = await this.promptForPlaceholders(placeholders, askQuestion);
      finalCommand = CommandProcessor.replacePlaceholders(detection.command, values);
      this.log(`\n✅ Updated command: ${finalCommand}`);
    }

    // Get final confirmation
    const confirmationPrompt = messages.getMessage('prompt-command-confirmation', [
      finalCommand,
      detection.description ?? 'Execute the suggested command',
    ]);

    this.log('\n' + confirmationPrompt);
    const confirmation = await askQuestion('\n> ');

    if (['y', 'yes'].includes(confirmation.toLowerCase().trim())) {
      const execution = await this.executeCommand(finalCommand);

      return `\n\nCommand executed: ${execution.command}\nSuccess: ${
        execution.success
      }\nOutput: ${execution.output.substring(0, 1000)}${execution.output.length > 1000 ? '...' : ''}`;
    } else {
      this.log(messages.getMessage('prompt-command-cancelled'));
      return null;
    }
  }

  /**
   * Process a user query and generate AI response
   */
  private async processUserQuery(
    userInput: string,
    chatMessages: AiMessage[],
    askQuestion: (prompt: string) => Promise<string>
  ): Promise<void> {
    if (this.isVerbose) {
      this.log('🔍 Searching documentation...');
    }

    // Retrieve relevant context
    const ragContext = await this.retrieveRelevantMessages(userInput);

    let userMessage: string;
    if (ragContext.relevantMessages.length > 0) {
      if (!this.isVerbose) {
        this.log(`📚 Found ${ragContext.relevantMessages.length} relevant sections`);
      }
      userMessage = this.createEnhancedContextWithHistory(userInput, ragContext);
    } else {
      if (!this.isVerbose) {
        this.log(messages.getMessage('info-no-documentation-found'));
      }
      userMessage = userInput;
    }

    chatMessages.push({ role: 'user', content: userMessage });

    try {
      // Get AI response
      const responseText = await this.aiService.generateResponse(chatMessages);
      chatMessages.push({ role: 'assistant', content: responseText });

      // Display response
      if (!this.isVerbose) {
        this.log('\n🤖 AI Assistant:');
        this.log(responseText);
      }

      // Handle command execution
      const commandDetection = CommandProcessor.extractCommand(responseText);
      const executionContext = await this.handleCommandExecution(commandDetection, askQuestion);

      // Update chat history with execution results
      if (executionContext && chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'assistant') {
        const updatedMessages = [...chatMessages];
        updatedMessages[updatedMessages.length - 1] = {
          ...updatedMessages[updatedMessages.length - 1],
          content: updatedMessages[updatedMessages.length - 1].content + executionContext,
        };
        chatMessages.splice(0, chatMessages.length, ...updatedMessages);
      }

      // Show sources
      if (ragContext.relevantMessages.length > 0) {
        const sources = ragContext.relevantMessages
          .map((m) => `${m.pluginName} - ${m.messageKey.replace(/_/g, ' ')}`)
          .join(', ');
        if (this.isVerbose) {
          this.log(`Response based on: ${sources}`);
        }
      }
    } catch (error) {
      if (!this.isVerbose) {
        this.log(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Create enhanced context including command history
   */
  private createEnhancedContextWithHistory(query: string, ragContext: RAGContext): string {
    let contextPrompt = MessageProcessor.createEnhancedPrompt(query, ragContext);

    // Add recent command history if available
    if (this.commandHistory.length > 0) {
      contextPrompt += '\n\nRECENT COMMAND HISTORY:\n' + '='.repeat(30) + '\n';

      const recentCommands = this.commandHistory.slice(-3);
      for (const cmd of recentCommands) {
        contextPrompt += `Command: ${cmd.command}\nSuccess: ${cmd.success}\n`;
        if (cmd.output) {
          contextPrompt += `Output: ${cmd.output.substring(0, 500)}${cmd.output.length > 500 ? '...' : ''}\n`;
        }
        contextPrompt += '---\n';
      }
    }

    return contextPrompt;
  }

  /**
   * Start interactive chat session
   */
  private async startInteractiveChat(chatMessages: AiMessage[]): Promise<void> {
    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const askQuestion = (prompt: string): Promise<string> => new Promise((resolve) => rl.question(prompt, resolve));

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const userInput = await askQuestion('\n💬 You: ');

        if (CommandProcessor.isExitCommand(userInput)) {
          this.log('\n👋 Goodbye!');
          break;
        }

        const trimmedInput = userInput.toLowerCase().trim();

        if (trimmedInput === 'help') {
          this.log(messages.getMessage('help-interactive'));
          continue;
        }

        if (trimmedInput === 'reload') {
          this.messageCache = [];
          this.searchService.clearIndex();
          // eslint-disable-next-line no-await-in-loop
          const allMessages = await this.loadAllMessages();
          if (this.isVerbose) {
            this.log(`🔄 Reloaded ${allMessages.length} documentation files`);
          }
          continue;
        }

        if (userInput.trim()) {
          // eslint-disable-next-line no-await-in-loop
          await this.processUserQuery(userInput, chatMessages, askQuestion);
        }
      }
    } finally {
      rl.close();
    }
  }
}
