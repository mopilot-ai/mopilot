// Every remote method's handler by name: (service, client, checked params) => result.
module.exports = {
  ...require('./read.cjs'),
  ...require('./chat.cjs'),
  ...require('./start.cjs'),
  ...require('./attach.cjs'),
  ...require('./card.cjs'),
  ...require('./review.cjs'),
  ...require('./mentions.cjs'),
  ...require('./device.cjs'),
  ...require('./pty.cjs'),
  ...require('./frames.cjs'),
  ...require('./momo.cjs'),
  ...require('./momoChannels.cjs'),
  ...require('./push.cjs'),
  ...require('./steps.cjs'),
  ...require('./host.cjs'),
  ...require('./chatsManage.cjs'),
};
