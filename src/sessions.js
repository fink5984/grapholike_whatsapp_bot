// סשן בזיכרון לכל משתמש — שומר מצב מילוי השדות
const sessions = new Map();

function getSession(phone) {
  return sessions.get(phone);
}

function setSession(phone, data) {
  sessions.set(phone, data);
}

function deleteSession(phone) {
  sessions.delete(phone);
}

module.exports = { getSession, setSession, deleteSession };
