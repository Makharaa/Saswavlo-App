import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, refreshCurrentSessionCookie } from "@/lib/auth";
import {
  getAdminUserById,
  updateUser,
} from "@/lib/users";
import { writeAuditLog } from "@/lib/audit";

const schema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  email: z.string().trim().email().max(220).optional(),
  role: z.enum(["admin", "driver"]).optional(),
  isActive: z.boolean().optional(),
  canUseRoutes: z.boolean().optional(),
  password: z.string().min(10).max(200).optional(),
});

function validationMessage(error: z.ZodError) {
  const issue = error.issues[0];
  const field = String(issue?.path?.[0] ?? "");

  if (field === "name") return "სახელი მინიმუმ 2 სიმბოლო უნდა იყოს.";
  if (field === "email") return "შეიყვანე სწორი ელფოსტის მისამართი.";
  if (field === "password") return "ახალი პაროლი მინიმუმ 10 სიმბოლო უნდა იყოს.";
  if (field === "role") return "მომხმარებლის როლი არასწორია.";
  if (field === "isActive") return "მომხმარებლის სტატუსი არასწორია.";
  if (field === "canUseRoutes") return "მარშრუტებზე წვდომის პარამეტრი არასწორია.";

  return "მონაცემები არასწორია. გადაამოწმე შევსებული ველები.";
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const current = await getCurrentUser();
  if (!current || current.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  const userId = Number(id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "Invalid user" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "მოთხოვნის მონაცემები ვერ წაიკითხა." },
      { status: 400 }
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: validationMessage(parsed.error) },
      { status: 400 }
    );
  }

  const input = parsed.data;

  try {
    const target = await getAdminUserById(userId);
    if (!target) {
      return NextResponse.json({ error: "მომხმარებელი ვერ მოიძებნა." }, { status: 404 });
    }

    if (userId === current.id && input.isActive === false) {
      return NextResponse.json(
        { error: "საკუთარი ანგარიშის გათიშვა არ შეგიძლია." },
        { status: 400 }
      );
    }

    if (
      (target.role === "admin" || input.role === "admin") &&
      input.canUseRoutes === false
    ) {
      return NextResponse.json(
        { error: "ადმინისტრატორს მარშრუტებზე სრული წვდომა უნდა ჰქონდეს." },
        { status: 400 }
      );
    }

    const normalizedInput = {
      ...input,
      ...(input.email !== undefined
        ? { email: input.email.trim().toLowerCase() }
        : {}),
    };

    const updated = await updateUser(userId, normalizedInput);
    if (!updated) {
      return NextResponse.json({ error: "მომხმარებელი ვერ მოიძებნა." }, { status: 404 });
    }

    // If an administrator changes their own role/email/name, keep the current
    // signed cookie synchronized with the database. The last-admin safety rule
    // is still enforced transactionally inside updateUser().
    if (userId === current.id) {
      await refreshCurrentSessionCookie(updated);
    }

    const changedFields = Object.keys(input).filter((key) => key !== "password");
    if (input.password) changedFields.push("password");

    // Audit logging must never make a successfully committed account update
    // look like a failed request to the administrator.
    try {
      await writeAuditLog({
        actorUserId: current.id,
        action: "user.updated",
        entityType: "user",
        entityId: updated.id,
        summary: `შეიცვალა მომხმარებელი: ${updated.name}`,
        metadata: {
          fields: changedFields,
          role: updated.role,
          isActive: updated.isActive,
          canUseRoutes: updated.canUseRoutes,
        },
      });
    } catch (auditError) {
      console.error("User update audit log failed:", auditError);
    }

    return NextResponse.json(updated);
  } catch (error: any) {
    console.error("Admin user update failed:", error);

    const duplicate = error?.code === "23505";
    return NextResponse.json(
      {
        error: duplicate
          ? "ეს ელფოსტა უკვე გამოყენებულია სხვა მომხმარებლის მიერ."
          : "ცვლილება ვერ შეინახა სერვერზე. სცადე თავიდან.",
        code: duplicate ? "EMAIL_ALREADY_EXISTS" : "USER_UPDATE_FAILED",
      },
      { status: duplicate ? 409 : 500 }
    );
  }
}
