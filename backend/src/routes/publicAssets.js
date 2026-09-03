'use strict';

/**
 * Public, unauthenticated static assets referenced from *outside* the app —
 * currently just the shop logo, loaded by an <img src="..."> in
 * transactional emails (templates/*.js). Serving it from a normal HTTPS URL
 * (rather than a CID-referenced attachment, the old approach) is what keeps
 * it from showing up as a paperclip/attachment in Gmail and other clients
 * that render CID images inline but still list them as attached. No
 * requireAuth: a recipient's mail client fetches this with no session at
 * all, same as the confirm/decline pages under /api/public/*.
 */

const express = require('express');
const path = require('path');

const router = express.Router();

const LOGO_PATH = path.resolve(__dirname, '../../../assets/CEPCO-LOGO-LIGHT.png');

router.get('/logo.png', (req, res) => {
  // Long-lived cache — this file only changes when someone replaces the
  // brand asset on disk and redeploys, which is rare enough that mail
  // clients (which fetch it fresh per open, unlike a browser) shouldn't be
  // hitting the app for it every time.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(LOGO_PATH);
});

module.exports = router;
