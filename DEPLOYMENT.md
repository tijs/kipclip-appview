# kipclip Deployment Guide

## Pre-deployment Checklist

### 1. Configure Val.town Environment Variables

In your Val.town project settings, add:

- `BASE_URL`: Your val.town URL (e.g., `https://kipclip-yourname.val.town`)

That's it! Val.town provides SQLite automatically - no external database setup
needed.

### 2. Deploy

```bash
# Run quality checks
deno task quality

# Deploy to Val.town
deno task deploy
```

## Post-deployment

### Test the OAuth Flow

1. Visit your Val.town URL
2. Enter your AT Protocol handle (e.g., `yourname.bsky.social`)
3. Complete OAuth authorization on your PDS
4. Verify you're redirected back and logged in

### Test Bookmark Features

1. Click "Add Bookmark"
2. Enter a URL (e.g., `https://github.com`)
3. Verify the bookmark appears with the page title
4. Test deletion

### Verify Data on PDS

Use the AT Protocol API to verify bookmarks are saved:

```bash
# List your bookmarks
curl https://bsky.social/xrpc/com.atproto.repo.listRecords \
  -G \
  --data-urlencode "repo=yourname.bsky.social" \
  --data-urlencode "collection=community.lexicon.bookmarks.bookmark"
```

## Troubleshooting

### OAuth Errors

- Check `BASE_URL` matches your Val.town URL exactly
- Check browser console for error messages
- Verify you're using the correct AT Protocol handle format

### URL Enrichment Not Working

- Check the target URL is accessible
- Verify it returns HTML content
- Check Val.town logs for fetch errors

## Monitoring

### View Application Logs

In Val.town dashboard, check the "Logs" tab for your val.

### Check Database

Val.town provides a SQLite database automatically. The OAuth sessions are stored
in the `iron_session_storage` table.

## Updating

```bash
# Pull latest changes
git pull

# Run quality checks
deno task quality

# Deploy
deno task deploy
```

## Security Notes

- OAuth tokens are stored securely in Val.town SQLite with iron-session
  encryption
- Sessions expire after 30 days
- Bookmarks are stored on user's PDS, not in appview database
- No sensitive data is logged
- All OAuth flows follow AT Protocol security best practices
