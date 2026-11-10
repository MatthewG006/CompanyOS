import { NextResponse } from "next/server";
import { getEventsData } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getEventsData();
  return NextResponse.json({ events: data.events, source: data.source });
}
