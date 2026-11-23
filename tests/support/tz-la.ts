// The Los Angeles clock for tests whose dates are local times (a daylight-saving change, quiet hours past midnight).
// Import it before anything else: an ES module's imports run before its own body, so a TZ set in a test's body comes
// after its helpers already made their dates on the runner's zone (CI's is UTC), and those dates move when it lands.
process.env.TZ = 'America/Los_Angeles';
