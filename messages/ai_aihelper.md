# summary

AI helper that interacts with Einstein AI to generate Salesforce CLI commands

# description

This command provides an interactive AI assistant that helps you discover and execute Salesforce CLI commands. It uses RAG (Retrieval-Augmented Generation) to search through Salesforce CLI documentation and provides context-aware responses with suggested commands.

# examples

- Start an interactive AI session:
  <%= config.bin %> <%= command.id %> --token YOUR_TOKEN

- Use verbose output to see detailed information:
  <%= config.bin %> <%= command.id %> --token YOUR_TOKEN --verbose

- Use a custom AI endpoint:
  <%= config.bin %> <%= command.id %> --token YOUR_TOKEN --location https://your-custom-endpoint.com

# flags.token.summary

Einstein AI access token

# flags.token.description

The access token for authenticating with Einstein AI services. This token is required to interact with the AI models.

# flags.location.summary

Custom AI endpoint location

# flags.location.description

Optional custom endpoint URL for the Einstein AI service. If not provided, the default production endpoint will be used.

# prompt-system

You are a helpful assistant for Salesforce CLI users. You have access to comprehensive Salesforce CLI documentation. When users ask questions, provide accurate, helpful responses based on the documentation. Always include specific command examples with proper syntax when relevant. If a command contains placeholders like <org-name>, explain that these need to be replaced with actual values.

# prompt-initial

🤖 Welcome to the Salesforce CLI AI Assistant!

Ask me anything about Salesforce CLI commands, and I'll help you find the right solution.
Type 'help' for available commands, 'reload' to refresh documentation, or 'exit' to quit.

What would you like to know?

# prompt-command-executing

⚡ Executing command: %s

# prompt-command-success

✅ Command completed successfully!

# prompt-command-error

❌ Command failed with error: %s

# prompt-command-confirmation

🔧 Suggested Command: %s

Description: %s

Would you like to execute this command? (y/n)

# prompt-command-cancelled

❌ Command execution cancelled.

# info-no-documentation-found

ℹ️ No specific documentation found, but I'll do my best to help!

# help-interactive

Available commands during interactive session:
• help - Show this help message
• reload - Reload the documentation cache
• exit/quit/bye - Exit the session

You can ask questions about Salesforce CLI commands and I'll search the documentation to provide helpful answers.

# flags.verbose.summary

Enable verbose output

# flags.verbose.description

Show detailed status messages and debugging information when enabled. This is useful for troubleshooting and understanding what the command is doing behind the scenes.
