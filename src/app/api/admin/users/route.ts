import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createUser, listUsers } from "@/lib/users";
import { writeAuditLog } from "@/lib/audit";

const schema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.string().email().max(220),
  password: z.string().min(10).max(200),
  role: z.enum(["admin", "driver"]),
});

async function admin() {
  const user = await getCurrentUser();
  return user?.role === "admin" && user.isActive ? user : null;
}

export async function GET() {
  if (!(await admin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(await listUsers());
}

export async function POST(request: Request) {
  const actor = await admin();
  if (!actor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const input = schema.parse(await request.json());
    const created = await createUser(input);
    await writeAuditLog({
      actorUserId: actor.id,
      action: "user.created",
      entityType: "user",
      entityId: created.id,
      summary: `შეიქმნა მომხმარებელი: ${created.name}`,
      metadata: { role: created.role, email: created.email },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error: any) {
    console.error(error);
    const duplicate = error?.code === "23505";
    return NextResponse.json(
      { error: duplicate ? "ეს ელფოსტა უკვე გამოყენებულია." : "მომხმარებელი ვერ შეიქმნა." },
      { status: 400 }
    );
  }
}
