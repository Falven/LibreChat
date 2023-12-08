const { posix, join } = require('node:path');
const { writeFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { StructuredTool } = require('langchain/tools');
const { z } = require('zod');
const {
  addCellsToNotebook,
  executeCode,
  getOrCreatePythonSession,
  initializeManagers,
  getOrCreateNotebook,
  createServerSettings,
  isDisplayData,
} = require('../util/jupyterServerUtils');
const { getDirname } = require('../util/envUtils');

/**
 * A simple example on how to use Jupyter server as a code interpreter.
 * Use a structured tool to inform the assistant that the code must be a string.
 */
class Python extends StructuredTool {
  /**
   * Constructs a new CodeInterpreter Tool for a particular user and their conversation.
   * @param {object} interpreterOptions The options for the interpreter.
   * @param {string} interpreterOptions.userId The user ID.
   * @param {string} interpreterOptions.conversationId The conversation ID.
   */
  constructor({ userId, conversationId, toolOutputCallback }) {
    super();

    this.name = 'python';
    // GPT4 Advanced Data Analysis prompt
    this.description =
      'When you send a message containing Python code to python, it will be executed in a stateful Jupyter notebook environment. Internet access for this session is disabled. Do not make external web requests or API calls as they will fail.';

    this.schema = z.object({
      code: z.string().describe('The python code to execute. Must be JSON escaped.'),
    });

    this.toolOutputCallback = toolOutputCallback;

    // The userId and conversationId are used to create a unique fs hierarchy for the notebook path.
    this.userId = userId;
    this.conversationId = conversationId;
    this.notebookName = `${conversationId}.ipynb`;
    this.notebookPath = posix.join(userId, this.notebookName);

    // Create single user Jupyter server settings.
    const serverSettings = createServerSettings();

    const { contentsManager, sessionManager } = initializeManagers(serverSettings);
    this.contentsManager = contentsManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Saves an image to the images directory.
   * @param base64ImageData The base64 encoded image data.
   */
  saveImage(base64ImageData) {
    const imageData = Buffer.from(base64ImageData, 'base64');
    const imageName = `${randomUUID()}.png`;
    const imagePath = join(
      getDirname(),
      '..',
      '..',
      '..',
      '..',
      '..',
      'client',
      'public',
      'images',
      imageName,
    );
    writeFileSync(imagePath, imageData);
    return imageName;
  }

  /**
   * Saves images to the images directory and returns markdown links to the images.
   * @param {*} outputs The outputs from the Jupyter kernel.
   * @returns {string[]} The markdown links to the images.
   */
  saveImages(outputs) {
    let markdownImages = [];
    for (const output of outputs) {
      if (isDisplayData(output)) {
        const imageOutput = output.data['image/png'];
        const imageName = this.saveImage(
          typeof imageOutput === 'object' ? JSON.stringify(imageOutput) : imageOutput,
        );
        markdownImages.push(`![Generated Image](/images/${imageName})`);
      }
    }
    return markdownImages;
  }

  /**
   * This method is called when the tool is invoked.
   * @param {any} arg The code to execute.
   * @returns {Promise<string>} The code execution output.
   */
  async _call(arg) {
    try {
      if (!arg.code) {
        throw new Error('Invalid tool input. Missing code property.');
      }
      const code = arg.code;

      // Get or Create the notebook if it doesn't exist.
      const notebookModel = await getOrCreateNotebook(this.contentsManager, this.notebookPath);

      // Get or create a Jupyter python kernel session.
      const session = await getOrCreatePythonSession(
        this.sessionManager,
        this.userId,
        this.notebookName,
        this.conversationId,
      );

      // Execute the code and get the result.
      const [result, outputs, executionCount] = await executeCode(session, code);

      // Save images to the images directory.
      const markdownImages = this.saveImages(outputs);

      // Pass image outputs to the outputs callback.
      this.toolOutputCallback(markdownImages);

      // Add the code and result to the notebook.
      addCellsToNotebook(notebookModel, code, outputs, executionCount);

      // Save the notebook.
      await this.contentsManager.save(this.notebookPath, notebookModel);

      // Return the result to the Assistant.
      return result;
    } catch (error) {
      console.error(error);
      // Inform the Assistant that an error occurred.
      return `Error executing code: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

module.exports = Python;
