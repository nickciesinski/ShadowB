import { NextResponse } from 'next/server';

// Fires the slate build on time, which GitHub's own scheduler does not.
//
// Measured GitHub scheduled-run lag on this repo: 39 min one night, 393 min
// the next, 13.6 h at worst. workflow_dispatch runs are exempt from that
// delay entirely — they start immediately. Vercel Hobby cron is ±59 min,
// which is bounded and predictable, so scheduling an hour early lands the
// slate before it is needed. See reference_github_cron_lag.
//
// Env required (Vercel project settings):
//   CRON_SECRET        Vercel sends this as `Authorization: Bearer <secret>`
//   GH_DISPATCH_TOKEN  GitHub PAT with `actions: write` on nickciesinski/ShadowB
export const dynamic = 'force-dynamic';

const REPO = 'nickciesinski/ShadowB';
const DEFAULT_WORKFLOW = 'morning-chain.yml';

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  // Fail closed. An unset secret must not leave the route open — this endpoint
  // can start a pipeline, so an unauthenticated caller could spam builds.
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: 'GH_DISPATCH_TOKEN not set' }, { status: 500 });
  }

  const url = new URL(request.url);
  const workflow = url.searchParams.get('workflow') || DEFAULT_WORKFLOW;
  // Allowlist: this route may only start the pipeline workflows, never an
  // arbitrary one supplied in a query string.
  const ALLOWED = new Set(['morning-chain.yml', 'evening-digest.yml', 'final-card.yml']);
  if (!ALLOWED.has(workflow)) {
    return NextResponse.json({ ok: false, error: `workflow not allowed: ${workflow}` }, { status: 400 });
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    // 204 No Content is success for this endpoint.
    if (res.status !== 204) {
      const body = await res.text();
      return NextResponse.json(
        { ok: false, workflow, status: res.status, error: body.slice(0, 500) },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, workflow, dispatchedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ ok: false, workflow, error: String(err && err.message) }, { status: 502 });
  }
}
