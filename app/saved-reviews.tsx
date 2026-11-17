"use client";

import { useEffect, useState } from "react";
import { listSavedReviews, normalizeReviewerId, type SavedReviewSummary } from "./review-workspace";

export function SavedReviews({ reviewerId, busy, onReviewerChange, onChoose }: {
  reviewerId: string;
  busy: boolean;
  onReviewerChange(id: string): void;
  onChoose(review: SavedReviewSummary): void;
}) {
  const [reviews, setReviews] = useState<SavedReviewSummary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void listSavedReviews(reviewerId).then((values) => {
      if (active) { setReviews(values); setError(""); }
    }).catch(() => {
      if (active) { setReviews([]); setError("Browser autosaves could not be read. You can open a saved workspace JSON below."); }
    });
    return () => { active = false; };
  }, [reviewerId]);
  const id = normalizeReviewerId(reviewerId);
  return <section className="saved-reviews" aria-label="Saved reviews">
    <label className="form-field"><span>Reviewer ID</span>
      <input disabled={busy} maxLength={32} placeholder="R017" value={reviewerId} onChange={(event) => onReviewerChange(event.target.value)} />
    </label>
    <h3>Saved reviews</h3>
    {error ? <p role="status">{error}</p> : !id ? <p>Enter your reviewer ID to find browser autosaves.</p>
      : !reviews.length ? <p>No browser autosaves for this ID yet.</p> : <>
        <p>Choose a review, then select its original recording folder.</p>
        <ul>{reviews.filter((review) => review.reviewerId === id).map((review) => <li key={review.instanceId}>
          <div><strong>{review.folderName} · Review {review.reviewSessionId}</strong>
            <span>{review.recordingPath}</span>
            <small>{new Date(review.updatedAt).toLocaleString()} · {review.visitedCount} visited · {review.labelCount} labels</small>
          </div>
          <button type="button" className="button secondary" disabled={busy} onClick={() => onChoose(review)}>Continue saved review</button>
        </li>)}</ul>
      </>}
    <small>Autosaves are stored in this browser. Save all into… creates portable files.</small>
  </section>;
}
