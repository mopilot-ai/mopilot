// Settings › About's performance log: a switch (off at every launch), and while it is on the numbers it has counted: JS and UI frames over 25 and 50 ms, JS stalls, touch to first commit, renders per screen. Counts and milliseconds only.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Share } from 'react-native';
import { Group, GroupItem, GroupLabel } from '../components/Grouped';
import { liveNetCounts, onLiveNetCounts } from '../presentation/liveWatch';
import { perf, type PerfReport } from '../perfLog';
import { t } from '../ui/i18n';

const frames = (f: PerfReport['js']) => t('perf.frames', { total: f.total, slow: f.over25, over: f.over50 });

export function AboutPerf() {
  const on = useSyncExternalStore(perf.subscribe, () => perf.enabled);
  const tracing = useSyncExternalStore(perf.subscribe, () => perf.tracing);
  const net = useSyncExternalStore(onLiveNetCounts, liveNetCounts);
  const [report, setReport] = useState<PerfReport | null>(null);
  useEffect(() => {
    if (!on) return setReport(null);
    setReport(perf.report());
    const id = setInterval(() => setReport(perf.report()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return (
    <>
      <GroupLabel>{t('perf.title')}</GroupLabel>
      <Group>
        <GroupItem
          key="switch"
          title={t('perf.record')}
          value={on ? t('perf.on') : t('perf.off')}
          detail={t('perf.note')}
          onPress={() => (on ? perf.end() : perf.start())}
        />
        {report && (
          <GroupItem
            key="trace"
            title={t('perf.trace')}
            value={tracing ? t('perf.on') : t('perf.off')}
            detail={t('perf.traceNote')}
            onPress={() => perf.trace(!tracing)}
          />
        )}
        <GroupItem
          key="live"
          title={t('perf.live')}
          value={t('perf.liveValue', { missed: net.missed, quiet: net.quiet })}
          detail={t('perf.liveNote')}
        />
        {report && <GroupItem key="js" title={t('perf.js')} value={frames(report.js)} />}
        {report && <GroupItem key="ui" title={t('perf.ui')} value={frames(report.ui)} />}
        {report && (
          <GroupItem
            key="stalls"
            title={t('perf.stalls')}
            value={t('perf.stallsValue', { count: report.stalls.count, worst: report.stalls.worst })}
          />
        )}
        {report && (
          <GroupItem
            key="touch"
            title={t('perf.touch')}
            value={t('perf.touchValue', { count: report.touch.count, median: report.touch.median, worst: report.touch.worst })}
          />
        )}
        {report && (
          <GroupItem
            key="frame"
            title={t('perf.frame')}
            value={t('perf.frameValue', {
              count: report.touch.frame.count,
              median: report.touch.frame.median,
              worst: report.touch.frame.worst,
              none: report.touch.noCommit,
            })}
          />
        )}
        {report && (
          <GroupItem
            key="queue"
            title={t('perf.queue')}
            value={t('perf.queueValue', { median: report.touch.queue.median, worst: report.touch.queue.worst })}
          />
        )}
        {report &&
          Object.entries(report.renders).map(([name, n]) => (
            <GroupItem
              key={`render-${name}`}
              title={name}
              value={t('perf.renderValue', { count: n, mean: report.renderMs[name]?.mean ?? 0, worst: report.renderMs[name]?.worst ?? 0 })}
            />
          ))}
        {report &&
          Object.entries(report.why).map(([name, causes]) => (
            <GroupItem
              key={`why-${name}`}
              title={`${name} · ${t('perf.why')}`}
              value={Object.entries(causes)
                .slice(0, 3)
                .map(([cause, n]) => `${cause} ${n}`)
                .join(' · ')}
            />
          ))}
        {report && !!Object.keys(report.events).length && (
          <GroupItem
            key="events"
            title={t('perf.events')}
            value={Object.entries(report.events)
              .map(([name, n]) => `${name} ${n}`)
              .join(' · ')}
          />
        )}
        {report && (
          <GroupItem
            key="share"
            title={t('perf.share')}
            onPress={() => void Share.share({ message: JSON.stringify(perf.report()) }).catch(() => null)}
          />
        )}
        {report && <GroupItem key="reset" title={t('perf.reset')} onPress={() => perf.reset()} />}
      </Group>
    </>
  );
}
