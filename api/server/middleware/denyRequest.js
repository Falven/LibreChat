const crypto = require('crypto');
const { sendMessage, sendError } = require('../utils');
const { getResponseSender } = require('../routes/endpoints/schemas');
const { saveMessage } = require('../../models');

/**
 * Denies a request by sending an error message and optionally saves the user's message.
 *
 * @async
 * @function
 * @param {Object} req - Express request object.
 * @param {Object} req.body - The body of the request.
 * @param {string} [req.body.messageId] - The ID of the message.
 * @param {string} [req.body.conversationId] - The ID of the conversation.
 * @param {string} [req.body.parentMessageId] - The ID of the parent message.
 * @param {string} req.body.text - The text of the message.
 * @param {Object} res - Express response object.
 * @param {string} errorMessage - The error message to be sent.
 * @returns {Promise<Object>} A promise that resolves with the error response.
 * @throws {Error} Throws an error if there's an issue saving the message or sending the error.
 */
const denyRequest = async (req, res, errorMessage) => {
  const { messageId, conversationId: _convoId, parentMessageId, text } = req.body;
  const conversationId = _convoId ?? crypto.randomUUID();

  const userMessage = {
    sender: 'User',
    messageId: messageId ?? crypto.randomUUID(),
    parentMessageId,
    conversationId,
    isCreatedByUser: true,
    text,
  };
  sendMessage(res, { message: userMessage, created: true });

  const shouldSaveMessage =
    _convoId && parentMessageId && parentMessageId !== '00000000-0000-0000-0000-000000000000';

  if (shouldSaveMessage) {
    await saveMessage(userMessage);
  }

  return await sendError(res, {
    sender: getResponseSender(req.body),
    messageId: crypto.randomUUID(),
    conversationId,
    parentMessageId: userMessage.messageId,
    text: errorMessage,
    shouldSaveMessage,
  });
};

module.exports = denyRequest;
