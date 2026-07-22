module.exports = (req, res) => {
  res.status(200).json({
    message: "Headers received successfully!",
    customHeaders: {
      numberone: req.headers['numberone'] || 'NOT FOUND',
      meterone: req.headers['meterone'] || 'NOT FOUND',
      'x-device-id': req.headers['x-device-id'] || 'NOT FOUND',
      'x-device-key': req.headers['x-device-key'] || 'NOT FOUND'
    },
    allHeaders: req.headers
  });
};
