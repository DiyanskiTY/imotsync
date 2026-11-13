import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * Aura with a darker primary colour in the light scheme. Aura's default (emerald 500 with white
 * text) is only about 2.5:1, below the WCAG AA minimum of 4.5:1 for text. Emerald 700 gives 5.5:1
 * for white text on primary buttons and for primary-coloured text on light surfaces.
 */
export const AppPreset = definePreset(Aura, {
  semantic: {
    colorScheme: {
      light: {
        primary: {
          color: '{primary.700}',
          contrastColor: '#ffffff',
          hoverColor: '{primary.800}',
          activeColor: '{primary.900}',
        },
        formField: {
          // Aura uses emerald 600 here, which is 3.8:1 on white: too light for a label.
          floatLabelFocusColor: '{primary.color}',
        },
      },
    },
  },
});
