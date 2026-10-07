import { NextResponse } from "next/server";
import { databaseAvailable } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await databaseAvailable();
  return NextResponse.json({ ok: db }, { status: db ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
