'use client'

import { useState } from 'react'

const soloManualSteps = [
  { time: '00:00', action: 'Staged changes made', detail: 'Developer updates critical routing middleware.' },
  { time: '00:02', action: 'Test suite execution', detail: 'Tests pass. Code is shipped directly to main without review.' },
  { time: '04:00', action: 'Production alert fires', detail: 'Latency spikes. Gateway is dropping 20% of incoming requests.' },
  { time: '04:15', action: 'Postmortem reconstruction', detail: 'Developer greps production logs to trace what changed.' },
]

const soloMergenSteps = [
  { time: '00:00', action: 'Commit hook triggered', detail: 'Git pre-commit matches staged files against local SQLite history.' },
  { time: '00:01', action: 'Outage risk flag raised', detail: 'Gateway identifies matching middleware in incident #84.' },
  { time: '00:02', action: 'Pre-emptive code fix', detail: 'Developer refactors before push. Potential outage avoided.' },
]

const manualSteps = [
  { time: '00:00', action: 'Agent task initialization', detail: 'Developer launches agent: "refactor database schema".' },
  { time: '05:00', action: 'Console buffer overload', detail: 'Agent prints thousands of stdout lines containing nested commands.' },
  { time: '15:00', action: 'Local runtime crash', detail: 'Web server drops. Staged DB state is corrupted.' },
  { time: '30:00', action: 'Manual git diff audit', detail: 'Developer inspects file mutations to identify root cause.' },
  { time: '60:00', action: 'Trace completed', detail: 'Discovered that agent deleted connection string configuration.' },
]

const mergenSteps = [
  { time: '00:00', action: 'Agent task initialization', detail: 'Developer launches agent: "refactor database schema".' },
  { time: '00:01', action: 'Synchronous tracing', detail: 'Gateway intercepts and records every command, read, and write.' },
  { time: '00:05', action: 'Living topology compiled', detail: 'Audit trail records hash chains of all tool actions.' },
  { time: '00:10', action: 'Visual execution map', detail: 'Living map displays exact path mutated by agent.' },
  { time: '00:15', action: 'Isolate error step', detail: 'Developer instantly spots connection string delete at step 42.' },
]

export default function LegacyVsMergen() {
  const [activeTab, setActiveTab] = useState<'prevent' | 'trace' | 'block' | 'policy'>('prevent')

  return (
    <section id="how" className="diff-section">
      <div className="section-header">
        <span className="section-label">EXECUTION_DIFFERENCE</span>
        <h2 className="section-title">
          Timeline: Inline controls vs. reactive triage
        </h2>
      </div>

      {/* Tab Switcher (Flat, hard-edged, monospace) */}
      <div className="diff-tabs font-mono">
        {[
          { id: 'prevent', label: 'INCIDENT_PREVENTION' },
          { id: 'trace', label: 'EXECUTION_TRACING' },
          { id: 'block', label: 'COMMAND_INTERCEPT' },
          { id: 'policy', label: 'PERSISTENT_POLICY' },
        ].map((t) => {
          const isActive = activeTab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id as any)}
              className={`diff-tab-btn ${isActive ? 'active' : ''}`}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Tab Content */}
      <div className="diff-content">
        {activeTab === 'prevent' && (
          <div>
            <div className="compare-grid">
              {/* Without */}
              <div className="compare-card compare-without">
                <div className="compare-header font-mono">WITHOUT_MERGEN (REACTIVE)</div>
                <div className="compare-timeline">
                  {soloManualSteps.map((s, i) => (
                    <div key={i} className="timeline-item">
                      <span className="timeline-time font-mono">{s.time}</span>
                      <div className="timeline-text">
                        <div className="timeline-action font-mono">{s.action}</div>
                        <div className="timeline-detail">{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {/* With */}
              <div className="compare-card compare-with">
                <div className="compare-header font-mono">WITH_MERGEN (INLINE GATE)</div>
                <div className="compare-timeline">
                  {soloMergenSteps.map((s, i) => (
                    <div key={i} className="timeline-item">
                      <span className="timeline-time font-mono">{s.time}</span>
                      <div className="timeline-text">
                        <div className="timeline-action font-mono">{s.action}</div>
                        <div className="timeline-detail">{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="compare-summary-box font-mono">
                  <span>OUTCOME:</span> Outage prevented. Incident history serves as a pre-commit gate before execution reaches production.
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'trace' && (
          <div>
            <div className="compare-grid">
              {/* Without */}
              <div className="compare-card compare-without">
                <div className="compare-header font-mono">WITHOUT_MERGEN (REACTIVE)</div>
                <div className="compare-timeline">
                  {manualSteps.map((s, i) => (
                    <div key={i} className="timeline-item">
                      <span className="timeline-time font-mono">{s.time}</span>
                      <div className="timeline-text">
                        <div className="timeline-action font-mono">{s.action}</div>
                        <div className="timeline-detail">{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {/* With */}
              <div className="compare-card compare-with">
                <div className="compare-header font-mono">WITH_MERGEN (INLINE GATE)</div>
                <div className="compare-timeline">
                  {mergenSteps.map((s, i) => (
                    <div key={i} className="timeline-item">
                      <span className="timeline-time font-mono">{s.time}</span>
                      <div className="timeline-text">
                        <div className="timeline-action font-mono">{s.action}</div>
                        <div className="timeline-detail">{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="compare-summary-box font-mono">
                  <span>OUTCOME:</span> Execution visualizer maps active directory mutations dynamically. Eliminates console trace overhead.
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'block' && (
          <div>
            <div className="compare-grid">
              {/* Without */}
              <div className="compare-card compare-without">
                <div className="compare-header font-mono">WITHOUT_MERGEN (REACTIVE)</div>
                <div className="compare-timeline">
                  {[
                    { time: '00.00s', action: 'Agent invokes execute_command', detail: '{"command": "terraform destroy -auto-approve"}' },
                    { time: '00.01s', action: 'Command execution starts', detail: 'No verification gate active. Handler processes tool call.' },
                    { time: '03.00s', action: 'Resources destroyed', detail: 'Production infrastructure teardown complete.' },
                  ].map((s, i) => (
                    <div key={i} className="timeline-item">
                      <span className="timeline-time font-mono">{s.time}</span>
                      <div className="timeline-text">
                        <div className="timeline-action font-mono">{s.action}</div>
                        <div className="timeline-detail">{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {/* With */}
              <div className="compare-card compare-with">
                <div className="compare-header font-mono">WITH_MERGEN (INLINE GATE)</div>
                <div className="compare-timeline">
                  {[
                    { time: '00.00s', action: 'Agent invokes execute_command', detail: '{"command": "terraform destroy -auto-approve"}' },
                    { time: '00.00s', action: 'Local gate interception', detail: 'Pattern check identifies "destroy" action within 1ms.' },
                    { time: '00.00s', action: 'Halt returned to caller', detail: 'Command blocks. Structured error returned to agent.' },
                  ].map((s, i) => (
                    <div key={i} className="timeline-item">
                      <span className="timeline-time font-mono">{s.time}</span>
                      <div className="timeline-text">
                        <div className="timeline-action font-mono">{s.action}</div>
                        <div className="timeline-detail">{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="compare-code-block font-mono">
                  <div className="code-header">GATEWAY LOG // TRIPPED</div>
                  <div>Tool: execute_command</div>
                  <div>Payload: "terraform destroy -auto-approve"</div>
                  <div className="text-block">Verdict: BLOCKED (policy: block_destructive_infra)</div>
                </div>
                <div className="compare-summary-box font-mono">
                  <span>OUTCOME:</span> Target command never executes. Gateway blocks before sub-process spawning on host.
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'policy' && (
          <div>
            <div className="compare-grid">
              {/* Without */}
              <div className="compare-card compare-without">
                <div className="compare-header font-mono">WITHOUT_MERGEN (REACTIVE)</div>
                <div className="compare-timeline">
                  {[
                    { time: 'Day 1', action: 'README instructions updated', detail: 'Developer documents: "Never delete postgres container".' },
                    { time: 'Day 15', action: 'Context window drift', detail: 'README omitted from prompt context or truncated.' },
                    { time: 'Day 90', action: 'Obsolete instruction runs', detail: 'New agent model executes prune command, deleting container.' },
                  ].map((s, i) => (
                    <div key={i} className="timeline-item">
                      <span className="timeline-time font-mono">{s.time}</span>
                      <div className="timeline-text">
                        <div className="timeline-action font-mono">{s.action}</div>
                        <div className="timeline-detail">{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {/* With */}
              <div className="compare-card compare-with">
                <div className="compare-header font-mono">WITH_MERGEN (INLINE GATE)</div>
                <div className="compare-timeline">
                  {[
                    { time: 'Day 1', action: 'Policy rule registered', detail: 'Local gate config updated to restrict database deletes.' },
                    { time: 'Day 90', action: 'Agent attempts prune', detail: 'Prune command matched against persistent JSON rules.' },
                    { time: 'Day 90', action: 'Execution blocked', detail: 'Command is intercepted. Action requires human signature.' },
                  ].map((s, i) => (
                    <div key={i} className="timeline-item">
                      <span className="timeline-time font-mono">{s.time}</span>
                      <div className="timeline-text">
                        <div className="timeline-action font-mono">{s.action}</div>
                        <div className="timeline-detail">{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="compare-summary-box font-mono">
                  <span>OUTCOME:</span> Persistent configuration ensures policy constraints remain active indefinitely, independent of context window size.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
