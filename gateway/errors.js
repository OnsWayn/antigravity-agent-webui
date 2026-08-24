function openaiError(status, message, code, type = 'invalid_request_error') {
  return {
    status,
    body: {
      error: {
        message,
        type,
        code: code || null
      }
    }
  };
}

function geminiError(status, message, statusName = 'INVALID_ARGUMENT') {
  return {
    status,
    body: {
      error: {
        code: status,
        message,
        status: statusName
      }
    }
  };
}

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function sendOpenAIError(res, status, message, code, type) {
  const error = openaiError(status, message, code, type);
  sendJson(res, error.status, error.body);
}

function sendGeminiError(res, status, message, statusName) {
  const error = geminiError(status, message, statusName);
  sendJson(res, error.status, error.body);
}

module.exports = {
  openaiError,
  geminiError,
  sendJson,
  sendOpenAIError,
  sendGeminiError
};
