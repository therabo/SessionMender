import { useEffect, useRef, useState } from 'react'
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog'
import { LoadingState, Notice } from '../../components/ui/feedback'
import { GlassButton } from '../../components/ui/glass'
import { errorText } from '../../lib/api/client'
import type { ClaudeReview, CodexReview, DeletionResult, Detail } from '../../lib/api/contracts'
import { numberLabel, pathLabel, sizeLabel } from '../../lib/utils/format'
import { confirmRemoval, reviewRemoval } from './api'

type Review = ClaudeReview | CodexReview

function ReviewedResources({ review }: { review: Review }) {
  if ('trees' in review.plan) {
    const targets = review.plan.trees.flatMap(tree => [
      tree.id,
      ...tree.descendants.filter(child => child.present).map(child => child.id),
    ])
    const count = new Set(targets).size
    return <p>{numberLabel(count)} {count === 1 ? 'session' : 'sessions'} in the removal plan</p>
  }

  const { directories, files, logical_bytes, history_matches, notes } = review.plan
  return <>
    <p>{numberLabel(files.length)} files · {numberLabel(directories.length)} folders · {sizeLabel(logical_bytes)}</p>
    <details>
      <summary>Files and folders</summary>
      <ul className="removal-targets">
        {directories.map(directory => <li key={JSON.stringify([directory.root, directory.relative_path])}>
          <code>{pathLabel(directory.relative_path)}/</code><br />{pathLabel(directory.root)}
        </li>)}
        {files.map(file => <li key={JSON.stringify([file.root, file.relative_path])}>
          <code>{pathLabel(file.relative_path)}</code><br />{pathLabel(file.root)} · {sizeLabel(file.bytes)}
        </li>)}
      </ul>
    </details>
    {history_matches !== null && <p>{numberLabel(history_matches)} matching history entries</p>}
    {notes.length > 0 && <ul>{notes.map(note => <li key={note}>{note}</li>)}</ul>}
    <p>Close Claude before confirming to reduce the chance of concurrent changes.</p>
  </>
}

export function RemovalDialog({ path, title, project = false, onClose, onChange }: {
  path: string; title: string; project?: boolean; onClose: () => void; onChange: (result?: DeletionResult) => void
}) {
  const [review, setReview] = useState<Review>()
  const [reviewError, setReviewError] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<DeletionResult>()
  const [busy, setBusy] = useState(false)
  const submitted = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    reviewRemoval<Review>(path, controller.signal).then(response => {
      if (!controller.signal.aborted) setReview(response)
    }).catch(failure => {
      if (!controller.signal.aborted) setReviewError(errorText(failure))
    })
    return () => controller.abort()
  }, [path])

  async function remove() {
    if (!review || submitted.current) return
    submitted.current = true
    setBusy(true)
    try {
      const outcome = await confirmRemoval(path, review.review)
      setResult(outcome)
      onChange(outcome)
    } catch (failure) {
      setError(errorText(failure))
      onChange()
    } finally {
      setBusy(false)
    }
  }

  const finished = !!(result || error)
  const completed = result?.status === 'deleted' && result.requested_absent !== false
  const partial = result?.status === 'partial' || (result?.status === 'deleted' && !completed)
  const confirmationTitle = project ? 'Remove project sessions?' : 'Remove this session?'
  return <ConfirmationDialog title={completed ? 'Deletion completed' : confirmationTitle}
    description={completed ? undefined : project ? 'The reviewed sessions and their descendants will be removed.'
      : review && 'files' in review.plan ? 'The reviewed session files and linked local artifacts will be removed.'
      : 'The selected session and its descendants will be removed.'}
    onClose={onClose} onConfirm={review && !finished ? () => void remove() : undefined} busy={busy} finished={finished && !completed}
    completed={completed}>
    <div className="confirmation-summary">
      <strong>{title}</strong>
      {review && <ReviewedResources review={review} />}
      {!review && !reviewError && <LoadingState title="Preparing removal review" />}
    </div>
    {(reviewError || error) && <Notice tone="error">{reviewError || error}</Notice>}
    {result && !completed && <Notice tone={partial ? 'warning' : 'error'}>
      <strong>{partial ? 'Partially removed' : 'Removal failed'}</strong>
      <p>{result.message}</p>
      {result.errors.length > 0 && <ul>{result.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>}
    </Notice>}
  </ConfirmationDialog>
}

export function SessionRemoval({ path, detail, onChange, onRemoved }: {
  path: string; detail: Detail; onChange: () => void; onRemoved: () => void
}) {
  const [reviewing, setReviewing] = useState(false)
  const [outcome, setOutcome] = useState<DeletionResult>()
  const unavailable = detail.claude_cleanup_supported ? null : detail.session.removal_reason
  const removed = outcome?.requested_absent ?? (outcome?.status === 'deleted')

  function closeReview() {
    setReviewing(false)
    if (removed) onRemoved()
  }

  return <footer className="preview-footer">
    {unavailable && <p className="removal-reason">{unavailable}</p>}
    {outcome && <p role="status" className="removal-reason">{outcome.message}</p>}
    <GlassButton tone="danger" disabled={!!unavailable || removed}
      onClick={() => setReviewing(true)}>Remove session</GlassButton>
    {reviewing && <RemovalDialog path={path} title={detail.session.title || detail.session.native_id}
      onChange={result => { setOutcome(result); onChange() }} onClose={closeReview} />}
  </footer>
}
