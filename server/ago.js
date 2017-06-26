'use strict'

// Should also work in the browser

var defaults = {
  prefixFromNow: 'in',
  suffixFromNow: null,
  prefixAgo: null,
  suffixAgo: 'ago',
  seconds: '<1 min',
  minute: '1 min',
  minutes: '%d min',
  hour: '1 hr',
  hours: '%d hrs',
  day: '1 day',
  days: '%d days',
  month: '1 mo',
  months: '%d mos',
  year: '1 yr',
  years: '%d yrs'
}

function format (template, num) {
  return template.replace('%d', num)
}

function make (overrides) {
  var config = Object.assign({}, defaults, overrides)

  var render = function (date) {
    var difference = Date.now() - date.getTime()

    var seconds = Math.abs(difference) / 1000
    var minutes = seconds / 60
    var hours = minutes / 60
    var days = hours / 24
    var years = days / 365

    var words = seconds < 45 && format(config.seconds, Math.round(seconds))
      || seconds < 90 && format(config.minute, 1)
      || minutes < 45 && format(config.minutes, Math.round(minutes))
      || minutes < 90 && format(config.hour, 1)
      || hours < 24 && format(config.hours, Math.round(hours))
      || hours < 42 && format(config.day, 1)
      || days < 30 && format(config.days, Math.round(days))
      || days < 45 && format(config.month, 1)
      || days < 365 && format(config.months, Math.round(days / 30))
      || years < 1.5 && format(config.year, 1)
      || format(config.years, Math.round(years))

    return (
      difference >= 0
      ? [config.prefixAgo, words, config.suffixAgo]
      : [config.prefixFromNow, words, config.suffixFromNow]
    ).filter(Boolean).join(' ')
  }

  var fork = function (newOverrides) {
    return make(Object.assign({}, overrides, newOverrides))
  }

  return Object.assign(render, { fork: fork })
}

if (typeof module !== 'undefined') {
  module.exports = make
} else {
  // expose instant to browser
  window.ago = make()
}
