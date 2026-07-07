-- Example series seed for the one-episode dry run (§8 step 8).
-- style_suffix locks the visual look across every episode of the series.

insert into hs_series (slug, name, sub_niche, style_suffix, voice_id, tone, active, post_time)
values (
  'forgotten-disasters',
  'Forgotten Disasters',
  'obscure historical catastrophes',
  'cinematic muted color grade, painterly animation, dramatic volumetric lighting, 9:16 vertical composition',
  'narrator_male_low',
  'grave, vivid, momentum-driven',
  true,
  '09:00'
)
on conflict (slug) do nothing;
