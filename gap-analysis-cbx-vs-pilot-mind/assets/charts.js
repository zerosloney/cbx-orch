(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();
  var warn = style.getPropertyValue('--warn').trim();

  // --- Chart 1: 六维能力雷达 ---
  var radarEl = document.getElementById('chart-radar');
  if (radarEl) {
    var radar = echarts.init(radarEl, null, { renderer: 'svg' });
    radar.setOption({
      animation: false,
      tooltip: { appendToBody: true },
      legend: {
        bottom: 0,
        textStyle: { color: muted, fontSize: 12 },
        itemWidth: 14,
        itemHeight: 8
      },
      radar: {
        indicator: [
          { name: '资源纳管', max: 5 },
          { name: '流程编排', max: 5 },
          { name: '执行引擎', max: 5 },
          { name: '治理审计', max: 5 },
          { name: '开放集成', max: 5 },
          { name: '企业运营', max: 5 }
        ],
        radius: '62%',
        center: ['50%', '47%'],
        axisName: { color: ink, fontSize: 12 },
        splitLine: { lineStyle: { color: rule } },
        splitArea: { areaStyle: { color: ['transparent', bg2] } },
        axisLine: { lineStyle: { color: rule } }
      },
      series: [
        {
          type: 'radar',
          data: [
            {
              name: 'pilot-mind 蓝图（愿景基准）',
              value: [5, 5, 5, 5, 5, 5],
              itemStyle: { color: accent2, opacity: 0.85 },
              lineStyle: { color: accent2, width: 2, type: 'dashed' },
              areaStyle: { color: accent2, opacity: 0.08 },
              symbol: 'circle',
              symbolSize: 4
            },
            {
              name: 'cbx-orch 现状',
              value: [2.5, 4.5, 4.5, 4.5, 2.5, 2.0],
              itemStyle: { color: accent },
              lineStyle: { color: accent, width: 2.5 },
              areaStyle: { color: accent, opacity: 0.18 },
              label: { show: true, color: ink, fontSize: 11, formatter: '{c}' },
              symbolSize: 5
            }
          ]
        }
      ]
    });
    window.addEventListener('resize', function () { radar.resize(); });
  }

  // --- Chart 2: 18 项能力逐项得分 ---
  var barEl = document.getElementById('chart-coverage');
  if (barEl) {
    // [label, score, group]  group: 0=六要素 1=七环 2=企业特性
    var items = [
      ['项目管理', 1, 0],
      ['Agent 纳管', 0.5, 0],
      ['Workflow 编排', 0.5, 0],
      ['Tool 纳管', 0.5, 0],
      ['知识库', 0, 0],
      ['模型管理', 0, 0],
      ['发现', 0, 1],
      ['注册', 0.5, 1],
      ['资产化', 0.5, 1],
      ['编排', 1, 1],
      ['执行', 1, 1],
      ['治理', 1, 1],
      ['对外开放', 0.5, 1],
      ['系统连接器', 0, 2],
      ['多租户/RBAC', 0.5, 2],
      ['行业场景包', 0, 2],
      ['私有化部署', 1, 2],
      ['审计合规', 1, 2]
    ];
    var groupColor = [accent, accent2, warn];
    var groupNames = ['六大要素', '七环链路', '企业特性'];

    var bar = echarts.init(barEl, null, { renderer: 'svg' });
    bar.setOption({
      animation: false,
      tooltip: {
        appendToBody: true,
        formatter: function (p) {
          var g = items[p.dataIndex][2];
          var s = items[p.dataIndex][1];
          var tag = s === 1 ? '✓ 生产级具备' : s === 0.5 ? '◐ 部分具备' : '✗ 未具备';
          return p.name + '<br/>' + groupNames[g] + ' · ' + tag;
        }
      },
      grid: { left: 8, right: 60, top: 10, bottom: 10, containLabel: true },
      xAxis: {
        type: 'value',
        max: 1,
        interval: 0.5,
        axisLabel: {
          color: muted,
          fontSize: 11,
          formatter: function (v) {
            return v === 1 ? '✓ 1' : v === 0.5 ? '◐ 0.5' : '✗ 0';
          }
        },
        splitLine: { lineStyle: { color: rule } }
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: items.map(function (d) { return d[0]; }),
        axisLabel: { color: ink, fontSize: 12 },
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false }
      },
      series: [
        {
          type: 'bar',
          data: items.map(function (d) {
            return {
              value: d[1],
              itemStyle: {
                color: d[1] === 1 ? groupColor[d[2]] : d[1] === 0.5 ? groupColor[d[2]] + '88' : rule,
                borderRadius: [0, 3, 3, 0]
              },
              label: {
                show: true,
                position: 'right',
                color: d[1] === 0 ? muted : ink,
                fontSize: 11,
                formatter: d[1] === 1 ? '✓' : d[1] === 0.5 ? '◐' : '✗'
              }
            };
          }),
          barWidth: '62%'
        }
      ]
    });
    window.addEventListener('resize', function () { bar.resize(); });
  }
})();
