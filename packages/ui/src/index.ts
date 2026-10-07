import { webLightTheme, type BrandVariants } from '@fluentui/react-components'

const aoaiBrand: BrandVariants = {
  10: '#020305',
  20: '#111820',
  30: '#172838',
  40: '#19374e',
  50: '#194766',
  60: '#17577e',
  70: '#126895',
  80: '#0f78ad',
  90: '#1689c4',
  100: '#2b99d6',
  110: '#44a9e4',
  120: '#5eb9ef',
  130: '#7ac8f7',
  140: '#98d6fc',
  150: '#b8e4ff',
  160: '#daf1ff',
}

export const aoaiLightTheme = {
  ...webLightTheme,
  colorBrandBackground: '#0f6cbd',
  colorBrandBackgroundHover: '#115ea3',
  colorBrandForeground1: '#0f6cbd',
  fontFamilyBase:
    '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", sans-serif',
  fontFamilyMonospace:
    '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
}

export { aoaiBrand }
