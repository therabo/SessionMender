import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { InventoryHeader } from '../../components/layout/InventoryHeader'
import { SplitWorkspace } from '../../components/layout/SplitWorkspace'
import { EmptyState, LoadingState, Notice, Pagination } from '../../components/ui/feedback'
import { GlassButton, GlassPanel } from '../../components/ui/glass'
import { errorText } from '../../lib/api/client'
import type { Project, ProjectPage, Provider } from '../../lib/api/contracts'
import { usePagedResource } from '../../lib/hooks/usePagedResource'
import { usePreview } from '../../lib/hooks/usePreview'
import { numberLabel } from '../../lib/utils/format'
import { listProjects, projectsPath, projectPath, refreshSessions, unassignedPath } from './api'
import { useSessionFilters } from './hooks/useSessionFilters'
import { SessionFilterFields } from './SessionFilters'
import { SessionGroup, SessionList, UnassignedSessions } from './SessionList'
import { SessionDetail } from './SessionDetail'
import { RemovalDialog } from './removal'

const projectPageSize = 12
const initiallyExpandedProjects = 2
const projectSessionsPath = (project: Project) => `${projectPath(project.provider, project.key)}/sessions`

function ProjectSessions({ project, index, query, revision, selected, onSelect, onRemove, onLoad }: {
  project: Project; index: number; query: string; revision: number; selected?: string
  onSelect: (key: string, opener: HTMLElement) => void; onRemove: (project: Project) => void
  onLoad?: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(index < initiallyExpandedProjects)
  const [visited, setVisited] = useState(expanded)
  const context = project.roots.join(' · ')

  return <SessionGroup title={project.name}
    context={[project.provider === 'codex' ? 'Registered project' : 'Project', context].filter(Boolean).join(' · ')}
    expanded={expanded} onToggle={() => { setExpanded(!expanded); setVisited(true) }}
    count={project.main_conversations}
    onRemove={project.removal_available ? () => onRemove(project) : undefined}>
    {visited && <SessionList key={query} path={projectSessionsPath(project)} label={project.name}
      query={query} revision={revision} selected={selected} onSelect={onSelect} expanded={expanded} onLoad={onLoad} />}
  </SessionGroup>
}

export function SessionInventory({ provider, heading, switched, providerSwitched, onInventoryChange }: {
  provider: Provider; heading: ReactNode; switched: boolean; providerSwitched: boolean; onInventoryChange: () => void
}) {
  const filters = useSessionFilters()
  const [revision, setRevision] = useState(0)
  const { loading, error, page } = usePagedResource(projectsPath(provider), filters.query, filters.pageIndex, projectPageSize, revision, listProjects, { delay: 150 })
  const detail = usePreview<string>()
  const [projectToRemove, setProjectToRemove] = useState<Project>()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const refreshPending = useRef(false)
  const [initialListsReady, setInitialListsReady] = useState(!providerSwitched || switched)
  const [loadedLists, setLoadedLists] = useState<{ page: ProjectPage; paths: Set<string> }>()
  const visiblePage = !initialListsReady && loading ? undefined : page
  const info = page?.provider
  const selected = detail.open ? detail.selection?.item : undefined
  const unavailable = info && info.coverage !== 'available'
  const emptyTitle = filters.active ? 'No matching sessions or projects' : 'No projects observed'
  const unassigned = unassignedPath(provider)
  // Reveal the first groups together so earlier rows cannot push visible headings down as they load.
  const loadedPaths = loadedLists?.page === visiblePage ? loadedLists?.paths : undefined
  const waitingForLists = !initialListsReady && Boolean(visiblePage && !error && (
    visiblePage.rows.slice(0, initiallyExpandedProjects).some(project => !loadedPaths?.has(projectSessionsPath(project)))
      || (info?.unassigned_sessions && !loadedPaths?.has(unassigned))
  ))
  const markListLoaded = useCallback((path: string) => {
    if (!visiblePage) return
    setLoadedLists(current => {
      const paths = current?.page === visiblePage ? current.paths : undefined
      return paths?.has(path) ? current : { page: visiblePage, paths: new Set(paths).add(path) }
    })
  }, [visiblePage])
  useEffect(() => {
    if (!initialListsReady && !loading && (error || (page && !waitingForLists))) setInitialListsReady(true)
  }, [initialListsReady, loading, error, page, waitingForLists])

  useEffect(() => {
    if (!loading && !error && page && filters.pageIndex > 0 && filters.pageIndex * projectPageSize >= page.total) filters.setPageIndex(0)
  }, [loading, error, page, filters.pageIndex, filters.setPageIndex])

  function invalidate() {
    setRevision(value => value + 1)
    onInventoryChange()
  }

  async function refresh() {
    if (refreshPending.current) return
    refreshPending.current = true
    setRefreshing(true)
    setRefreshError('')
    try {
      await refreshSessions(provider)
      filters.setPageIndex(0)
      invalidate()
    } catch (failure) {
      setRefreshError(errorText(failure))
    } finally {
      refreshPending.current = false
      setRefreshing(false)
    }
  }

  return <>
    <SplitWorkspace label="Session details" open={detail.open} opener={detail.selection?.opener}
      onClose={detail.close} preview={detail.selection && <SessionDetail key={detail.selection.item} provider={provider}
        rowKey={detail.selection.item} onClose={detail.close} onChange={invalidate} />}>
      <GlassPanel className="inventory-panel sessions-panel" data-switched={switched}
        data-provider-switched={providerSwitched} tabIndex={-1} aria-label="Sessions inventory">
        <InventoryHeader heading={heading} count={info?.coverage === 'available'
          ? `${numberLabel(info.total)} ${info.sessions_observed_only ? 'observed ' : ''}sessions`
          : '— sessions'}
          action={<GlassButton className="square" tone="quiet" aria-label="Refresh sessions" title="Refresh sessions"
            disabled={refreshing} onClick={() => void refresh()}><RefreshCw className={refreshing ? 'spin' : undefined} size={15} aria-hidden /></GlassButton>}>
          <SessionFilterFields filters={filters.filters} onChange={filters.update} />
        </InventoryHeader>
        <div className="inventory-body" aria-busy={loading || waitingForLists}>
          {refreshError && <Notice tone="error">{refreshError}</Notice>}
          {((!visiblePage && loading) || waitingForLists) && <LoadingState title="Loading projects" />}
          {error && <Notice tone="error">{error}</Notice>}
          <div hidden={waitingForLists}>
            {!error && visiblePage?.rows.map((project, index) => <ProjectSessions key={project.key} project={project} index={index}
              query={filters.query} revision={revision} selected={selected} onSelect={detail.show} onRemove={setProjectToRemove}
              onLoad={!initialListsReady && index < initiallyExpandedProjects ? markListLoaded : undefined} />)}
            {!error && !loading && page?.total === 0 && info?.unassigned_sessions === 0 &&
              <EmptyState title={unavailable ? 'Archive unavailable' : emptyTitle}>
                {unavailable && <p lang="it">{info.archive_error}</p>}
              </EmptyState>}
            {visiblePage && !error && <Pagination total={visiblePage.total} page={filters.pageIndex} pageSize={projectPageSize}
              onPage={filters.setPageIndex} label="Project pages" />}
            {visiblePage && info?.unassigned_sessions ? <UnassignedSessions key={filters.query} path={unassigned}
              query={filters.query} revision={revision} selected={selected} onSelect={detail.show} label="Unassigned sessions"
              count={info.unassigned_sessions} onLoad={!initialListsReady ? markListLoaded : undefined}
              emptyTitle={!loading && page?.total === 0 ? emptyTitle : undefined} /> : null}
          </div>
        </div>
      </GlassPanel>
    </SplitWorkspace>
    {projectToRemove && <RemovalDialog path={projectPath(provider, projectToRemove.key)} title={projectToRemove.name}
      project onClose={() => setProjectToRemove(undefined)} onChange={invalidate} />}
  </>
}
