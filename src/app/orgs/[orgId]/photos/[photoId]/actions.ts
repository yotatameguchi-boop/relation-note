"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { toMessage } from "@/lib/errors";
import type { SubmitReview } from "@/components/PhotoReviewer";

export const submitPhotoReview: SubmitReview = async (input) => {
  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_photo_count_review", {
    photo: input.photoId, result_id: input.resultId, removed: input.removed, added: input.added, moved: input.moved,
    p_confirmed: input.confirmed, p_note: input.note, p_seconds: input.seconds,
  });
  if (error) return { error: toMessage(error, "確定できませんでした。") };
  revalidatePath(`/orgs/${input.orgId}/photos/${input.photoId}`);
  return {};
};
