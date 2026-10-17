import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const archive = await readFile(join(process.cwd(), ".local", "submission", "monad-x402-demo-source.zip"));
    return new Response(new Uint8Array(archive), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="monad-x402-demo-source.zip"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "Source archive has not been prepared." }, { status: 503 });
  }
}
