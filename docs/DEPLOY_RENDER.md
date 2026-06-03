# Render Free Deployment

This test build is a Node web service, so Render Free Web Service is the lowest-change free deployment path.

## Suggested Free Domains

Use the shortest available Render service name:

- `yuanye-test` -> `https://yuanye-test.onrender.com`
- `yuanye-pattern` -> `https://yuanye-pattern.onrender.com`
- `yuanye-repeat` -> `https://yuanye-repeat.onrender.com`
- `yuanye-tile` -> `https://yuanye-tile.onrender.com`

The project is already configured with `yuanye-test` in `render.yaml`. If Render says the name is unavailable, change only the `name` field.

## Deploy Steps

1. Upload this project to a private GitHub repository.
2. Open Render and create a new Blueprint from the repository.
3. Confirm the service plan is `free`.
4. Set these environment variables in Render:

```bash
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://maimai.it.com/v1
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_CHAT_MODEL=gpt-5.5
YUANYE_PASSWORD=your_login_password
YUANYE_HOST=0.0.0.0
```

Do not put secrets in `.env` before uploading the repository. `.env`, `history/`, and `logs/` are ignored by `.gitignore`.

## Testing Notes

- Render Free Web Services sleep after idle time, so the first request may be slow.
- Generated history files are stored on the service filesystem and should be treated as temporary on the free plan.
- For the test version, use the free `onrender.com` domain first. Buy or attach a custom domain only after the image workflow is stable.
- To adjust the site, push changes to GitHub and redeploy from Render.
