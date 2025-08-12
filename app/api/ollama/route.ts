// @ts-ignore
import { NextRequest, NextResponse } from "next/server";

async function handle(req: any) {
  try {
    // For now, return a simple response to test the route
    const response = { 
      error: "Ollama integration in progress",
      message: "Please check back later" 
    };
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}

export const GET = handle;
export const POST = handle;

export const runtime = "edge";
