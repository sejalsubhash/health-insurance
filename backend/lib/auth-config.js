/**
 * Microsoft Entra ID (O365) SSO Configuration
 * Session-based auth with passport-azure-ad
 */
const passport = require('passport');
const { OIDCStrategy } = require('passport-azure-ad');

function configureAuth(app) {
  // Validate all required vars before attempting strategy creation
  const clientId = process.env.AZURE_AD_CLIENT_ID || '';
  const clientSecret = process.env.AZURE_AD_CLIENT_SECRET || '';
  const tenantId = process.env.AZURE_AD_TENANT_ID || '';
  const redirectUri = process.env.AZURE_AD_REDIRECT_URI || '';

  if (!clientId || !clientSecret || !tenantId || !redirectUri || !redirectUri.startsWith('https://')) {
    console.log('Azure AD: Missing or invalid config — SSO disabled. Required: CLIENT_ID, CLIENT_SECRET, TENANT_ID, REDIRECT_URI (must be https://)');
    return;
  }

  try {
    const config = {
      identityMetadata: `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`,
      clientID: clientId,
      clientSecret: clientSecret,
      responseType: 'code',
      responseMode: 'form_post',
      redirectUrl: redirectUri,
      allowHttpForRedirectUrl: false,
      scope: ['openid', 'profile', 'email', 'User.Read'],
      passReqToCallback: false,
      loggingLevel: 'warn',
      loggingNoPII: true
    };

  const strategy = new OIDCStrategy(config, (iss, sub, profile, accessToken, refreshToken, done) => {
    const user = {
      oid: profile.oid,
      email: profile._json?.preferred_username || profile._json?.email || '',
      name: profile.displayName || profile._json?.name || '',
      given_name: profile._json?.given_name || '',
      family_name: profile._json?.family_name || ''
    };
    return done(null, user);
  });

  passport.use(strategy);

  passport.serializeUser((user, done) => {
    done(null, user);
  });

  passport.deserializeUser((user, done) => {
    done(null, user);
  });

  app.use(passport.initialize());
  app.use(passport.session());
  console.log('Azure AD SSO configured successfully');
  } catch (err) {
    console.error('Azure AD configuration failed:', err.message);
    console.log('SSO disabled — use SKIP_AUTH=true for dev access');
  }
}

// Middleware: require authentication
function requireAuth(req, res, next) {
  // Check for demo login session first
  if (req.session?.demoUser) {
    req.user = req.session.demoUser;
    return next();
  }

  // Skip auth in development if configured
  if (process.env.SKIP_AUTH === 'true') {
    req.user = {
      email: process.env.SUPER_ADMIN_EMAIL || 'dev@acc.ltd',
      name: 'Dev User',
      role: 'Super Admin'
    };
    return next();
  }

  if (req.isAuthenticated && req.isAuthenticated()) {
    // Attach role from cached user registry
    if (!req.user.role) {
      const s3Client = require('./s3-client');
      s3Client.getUsers().then(users => {
        const u = users.find(u => u.email.toLowerCase() === req.user.email.toLowerCase());
        if (req.user.email.toLowerCase() === (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase()) {
          req.user.role = 'Super Admin';
        } else if (u) {
          req.user.role = u.role || 'Viewer';
          req.user.vendor_id = u.vendor_id || null;
          req.user.status = u.status || 'active';
        } else {
          req.user.role = 'Viewer';
        }
        if (req.user.status === 'disabled') return res.status(403).json({ error: 'Account disabled' });
        next();
      }).catch(() => { req.user.role = 'Viewer'; next(); });
      return;
    }
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
}

// Middleware: require specific roles
function requireRole(...roles) {
  return async (req, res, next) => {
    if (req.session?.demoUser) {
      req.user = req.session.demoUser;
      if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient role' });
      return next();
    }

    if (process.env.SKIP_AUTH === 'true') {
      req.user = { email: process.env.SUPER_ADMIN_EMAIL || 'dev@acc.ltd', name: 'Dev User', role: 'Super Admin' };
      return next();
    }

    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Resolve role if not cached
    if (!req.user.role) {
      try {
        const s3Client = require('./s3-client');
        const users = await s3Client.getUsers();
        const user = users.find(u => u.email.toLowerCase() === req.user.email.toLowerCase());
        if (req.user.email.toLowerCase() === (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase()) {
          req.user.role = 'Super Admin';
        } else if (user) {
          req.user.role = user.role || 'Viewer';
          req.user.vendor_id = user.vendor_id || null;
        } else {
          req.user.role = 'Viewer';
        }
      } catch(e) { req.user.role = 'Viewer'; }
    }

    // Super admin from env always has access
    if (req.user.email.toLowerCase() === (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase()) {
      req.user.role = 'Super Admin';
      return next();
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions. Required: ' + roles.join(' or ') });
    }

    next();
  };
}

module.exports = { configureAuth, requireAuth, requireRole };
