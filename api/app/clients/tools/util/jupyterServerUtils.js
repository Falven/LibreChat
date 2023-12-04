const { posix } = require('node:path');
const {
  ServerConnection,
  KernelManager,
  SessionManager,
  ContentsManager,
} = require('@jupyterlab/services');
const {
  isExecuteResultMsg,
  isDisplayDataMsg,
  isStreamMsg,
  isErrorMsg,
} = require('@jupyterlab/services/lib/kernel/messages');
const crypto = require('node:crypto');
const { getRequiredEnvVar } = require('./envUtils');

const serverUrl = getRequiredEnvVar('JUPYTER_URL');
const token = getRequiredEnvVar('JUPYTER_TOKEN');

/**
 * Create settings for a general, single-user Jupyter server.
 * @returns {ServerConnection.ISettings} The server settings.
 */
const createServerSettings = () => {
  return ServerConnection.makeSettings({
    baseUrl: `http://${serverUrl}`,
    wsUrl: `ws://${serverUrl}`,
    token,
  });
};

/**
 * Create settings for a Jupyter server for a specific user.
 * @param username The username of the user.
 * @returns {ServerConnection.ISettings} The server settings.
 */
const createServerSettingsForUser = (username) => {
  return ServerConnection.makeSettings({
    baseUrl: `http://${serverUrl}/user/${username}`,
    wsUrl: `ws://${serverUrl}/user/${username}`,
    token,
  });
};

/**
 * Create managers to interact with the Jupyter server.
 * @param serverSettings The server settings.
 * @returns {Managers} The managers.
 */
const initializeManagers = (serverSettings) => {
  const kernelManager = new KernelManager({ serverSettings });
  const sessionManager = new SessionManager({ serverSettings, kernelManager });
  const contentsManager = new ContentsManager({ serverSettings });
  return { kernelManager, sessionManager, contentsManager };
};

/**
 * Iterates the Jupyter Server directories, creating missing directories to form the structure denoted by path.
 * @param contentsManager The contents manager used to create the directory structure.
 * @param path A POSIX path to of directories to create.
 */
const createDirectoryStructure = async (contentsManager, path) => {
  let currentPath = posix.sep;
  const directories = path.split(posix.sep);
  for (const directory of directories) {
    const model = await contentsManager.get(currentPath);
    if (
      !model.content.find((content) => content.name === directory && content.type === 'directory')
    ) {
      await contentsManager.newUntitled({ type: 'directory' });
      await contentsManager.rename('Untitled Folder', directory);
    }
    currentPath = posix.join(currentPath, directory);
  }
};

/**
 * Creates a new notebook model.
 * @param {Contents.IModel['name']} name The name of the notebook.
 * @param {Contents.IModel['path']} path The path of the notebook.
 * @returns {Contents.IModel} The notebook model.
 */
const getNewNotebookModel = (name, path) => ({
  name,
  path,
  content: {
    metadata: {},
    nbformat_minor: 5,
    nbformat: 4,
    cells: [],
  },
  writable: true,
  created: new Date().toISOString(),
  last_modified: new Date().toISOString(),
  mimetype: 'null',
  format: null,
  type: 'notebook',
});

/**
 * Gets an existing notebook or creates a new notebook.
 * @param contentsManager The contents manager used to get or create the notebook.
 * @param notebookPath The path of the notebook.
 * @returns {Promise<Contents.IModel>} The notebook model.
 */
const getOrCreateNotebook = async (contentsManager, notebookPath) => {
  const dirname = posix.dirname(notebookPath);
  await createDirectoryStructure(contentsManager, dirname);

  let model;
  const name = posix.basename(notebookPath);
  const contents = await contentsManager.get(dirname);
  const content = contents.content;
  if (content.find((content) => content.name === name && content.type === 'notebook')) {
    model = await contentsManager.get(notebookPath);
  } else {
    model = getNewNotebookModel(name, notebookPath);
  }
  return model;
};

/**
 * Attempts to find an existing session by userId. If no session is found, a new session is started.
 * @param sessionManager The session manager used to find or create the session.
 * @param userId The userId used to find the session.
 * @param notebookName The name of the notebook.
 * @param notebookPath The path of the notebook.
 * @returns {Promise<Session.ISessionConnection>} The session connection.
 */
const getOrCreatePythonSession = async (sessionManager, userId, notebookName, notebookPath) => {
  if (!sessionManager.isReady) {
    await sessionManager.ready;
  }

  const session = await sessionManager.findByPath(notebookPath);
  if (session !== undefined) {
    return sessionManager.connectTo({ model: session });
  }

  return await sessionManager.startNew(
    {
      name: notebookName,
      path: notebookPath,
      type: 'notebook',
      kernel: { name: 'python3' },
    },
    { username: userId },
  );
};

/**
 * Processes a message from the Jupyter kernel and returns a list of outputs and the final result.
 * @param {IIOPubMessage<IOPubMessageType>} msg The message from the Jupyter kernel.
 * @param {IOutput[]} outputs The list of outputs.
 */
const processMessage = async (msg, outputs) => {
  outputs.push({
    output_type: msg.header.msg_type,
    ...msg.content,
  });

  let result = '';
  let execution_count = null;
  if (isExecuteResultMsg(msg)) {
    const textOutput = msg.content.data['text/plain'];
    result += typeof textOutput === 'object' ? JSON.stringify(textOutput) : textOutput;
    execution_count = msg.content.execution_count;
  } else if (isDisplayDataMsg(msg)) {
    result += 'Image displayed.';
  } else if (isStreamMsg(msg)) {
    result += msg.content.text;
  } else if (isErrorMsg(msg)) {
    result += msg.content.traceback.join('\n');
  }

  return [result, execution_count];
};

/**
 * Executes code in the Jupyter kernel and returns a list of outputs and the final result computed from the outputs.
 * @param {Session.ISessionConnection} session The session connection.
 * @param input The code to execute.
 * @returns {[string, Output[]]} The final result and the list of outputs used to calculate the result.
 */
const executeCode = async (session, input) => {
  if (!session.kernel) {
    throw new Error('Kernel is not defined');
  }

  const future = session.kernel.requestExecute({ code: input });

  let result = '';
  let executionCount = null;
  const outputs = [];
  future.onIOPub = async (msg) => {
    const [partialResult, execution_count] = await processMessage(msg, outputs);
    result += partialResult;
    executionCount = execution_count;
  };
  await future.done;

  return [result, outputs, executionCount];
};

/**
 * Adds code cells to a notebook.
 * @param model The notebook model.
 * @param source The source code of the cell.
 * @param executeResultMsg The execute result message.
 */
const addCellsToNotebook = (model, source, outputs, execution_count) => {
  if (model.type !== 'notebook') {
    throw new Error('Model is not a notebook');
  }
  model.content.cells.push({
    cell_type: 'code',
    source,
    metadata: {},
    id: crypto.randomUUID(),
    outputs,
    execution_count,
  });
};

/**
 * Test whether an output is from display data.
 */
const isDisplayData = (output) => output.output_type === 'display_data';

module.exports = {
  createServerSettings,
  createServerSettingsForUser,
  initializeManagers,
  getOrCreateNotebook,
  getOrCreatePythonSession,
  executeCode,
  addCellsToNotebook,
  isDisplayData,
};
