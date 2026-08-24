/* ============================================================================
 * sample.js — a bundled demonstration document.
 *
 * Written for this project so that a reviewer with no file to hand can still
 * exercise the full pipeline. It is deliberately imperfect: a few sentences run
 * long, a few are passive, and one idea is stated twice — so the improvement
 * checks have something real to find rather than returning a row of green ticks.
 *
 * Shape matches what the PDF extractor produces: an ordered list of blocks,
 * each tagged heading or paragraph, each knowing its page.
 * ========================================================================== */
(function (global) {
  'use strict';

  var B = [
    { type: 'heading', page: 1, text: 'Urban Heat Islands and Municipal Response: A Field Review' },
    { type: 'paragraph', page: 1, text: 'This report reviews how mid-sized cities are measuring and responding to urban heat, and argues that the cheapest interventions are consistently the ones that go unfunded. Between 2015 and 2024 the number of municipalities in the study set that published a formal heat action plan rose from 11 to 78, but only 19 of those plans attached a recurring budget line to the measures they recommended.' },
    { type: 'paragraph', page: 1, text: 'The urban heat island effect describes the tendency of built-up areas to hold more heat than the countryside around them. Asphalt, concrete and roofing membranes absorb solar radiation during the day and release it slowly after sunset, so the difference between a city centre and its rural surroundings is usually largest a few hours after dark rather than at noon.' },

    { type: 'heading', page: 1, text: '1. Measurement' },
    { type: 'paragraph', page: 1, text: 'Three measurement approaches dominate current practice. Fixed weather stations give long, consistent records but are sparse, and in the study set the median city operated only four of them. Mobile transects, in which a sensor is driven along a fixed route at a fixed hour, capture street-level variation at much finer resolution and have become the standard method for community science campaigns. Satellite thermal imagery covers everything at once but measures surface temperature rather than air temperature, and the two can differ by more than 10 °C over dry asphalt in the early afternoon.' },
    { type: 'paragraph', page: 1, text: 'It should be noted that the choice of method is very often driven by budget rather than by the question being asked. Campaigns that were funded through public health departments tended to use mobile transects, whereas campaigns run by planning departments were more likely to rely on satellite products that had already been purchased for other purposes.' },
    { type: 'paragraph', page: 2, text: 'A recurring finding across the study set is that intra-city variation exceeds inter-city variation. In other words, the difference between the hottest and coolest neighbourhood within a single city was larger, in 34 of 41 cases, than the difference between the average temperatures of any two cities in the same climate zone. Heat is therefore best understood as a neighbourhood-scale problem.' },

    { type: 'heading', page: 2, text: '2. Who is exposed' },
    { type: 'paragraph', page: 2, text: 'Exposure is not distributed evenly. Neighbourhoods with less than 10% canopy cover recorded evening temperatures an average of 4.1 °C higher than neighbourhoods above 30% cover in the same city on the same night. Canopy cover in the study set correlated with median household income at r = 0.62, which means that the hottest streets are also, as a rule, the streets least able to run air conditioning through a long evening.' },
    { type: 'paragraph', page: 2, text: 'Emergency department admissions for heat-related illness were shown by the 2023 multi-city analysis to rise sharply once night-time minimums stay above 25 °C for three consecutive nights. The threshold matters more than the daytime peak because recovery happens at night; a body that does not cool down overnight starts the next day already in deficit.' },

    { type: 'heading', page: 2, text: '3. What actually works' },
    { type: 'paragraph', page: 2, text: 'Four interventions were assessed against cost per degree of measured cooling. Street trees performed best over a twenty-year horizon but are slow, and a sapling planted today provides meaningful shade only after eight to twelve years. Reflective or "cool" roof coatings are the fastest to deploy and cut peak indoor temperature in single-storey buildings by 2 to 3 °C, though the effect on street-level air temperature is small.' },
    { type: 'paragraph', page: 3, text: 'Shade structures at transit stops are cheap, immediate and unglamorous, and they were the single most cost-effective measure in the review. Cooling centres, by contrast, were the most commonly funded intervention and the least effective per dollar, largely because they are used by a small fraction of the population at risk and only during declared emergencies.' },
    { type: 'paragraph', page: 3, text: 'The cheapest interventions are consistently the ones that go unfunded, and the pattern repeats across every city in the study set. Political visibility, rather than measured benefit, appears to drive which measures receive recurring budget.' },

    { type: 'heading', page: 3, text: '4. Recommendations' },
    { type: 'paragraph', page: 3, text: 'Cities should publish neighbourhood-level heat data rather than city-wide averages, because a single city figure conceals exactly the variation that determines who is harmed. Heat action plans must attach a recurring budget line to each measure they recommend; a plan without a budget is a description of a problem, not a response to it. Finally, night-time minimum temperature should replace daytime maximum as the headline metric in public communication, since it is the better predictor of harm.' },
    { type: 'paragraph', page: 3, text: 'In conclusion, the technical questions in this field are largely settled and the remaining problems are budgetary and institutional. The measurement tools are adequate, the interventions are known, and the ranking between them is stable across climates.' }
  ];

  var words = 0;
  for (var i = 0; i < B.length; i++) words += B[i].text.split(/\s+/).length;

  global.Lens = global.Lens || {};
  global.Lens.SAMPLE = {
    name: 'urban-heat-field-review.pdf',
    size: B.reduce(function (a, b) { return a + b.text.length; }, 0),
    words: words,
    blocks: B
  };
})(typeof window !== 'undefined' ? window : globalThis);
